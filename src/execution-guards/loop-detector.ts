import { createHash } from "node:crypto";
import {
  DEFAULT_LOOP_GUARD_CONFIG,
} from "./config";
import type {
  AdapterRuntimeEvent,
  RuntimeGuardDecision,
  RuntimeLoopGuardConfig,
} from "./types";

interface SeenToolCall {
  stableKey: string;
  toolName: string;
}

export class RuntimeLoopDetector {
  private readonly config: RuntimeLoopGuardConfig;
  private readonly recent: SeenToolCall[] = [];
  private readonly warnedKeys = new Set<string>();
  private readonly warnedTools = new Set<string>();

  constructor(config: Partial<RuntimeLoopGuardConfig> = {}) {
    this.config = { ...DEFAULT_LOOP_GUARD_CONFIG, ...config };
  }

  observe(event: AdapterRuntimeEvent): RuntimeGuardDecision {
    if (this.config.mode === "off" || event.type !== "tool_call") {
      return none(event);
    }

    const toolName = normalizeToolName(event.toolName);
    const stableKey = stableToolCallKey(event);
    this.recent.push({ stableKey, toolName });
    if (this.recent.length > this.config.windowSize) {
      this.recent.splice(0, this.recent.length - this.config.windowSize);
    }

    const repeatedCount = this.recent.filter((entry) => entry.stableKey === stableKey).length;
    const toolFrequency = this.recent.filter((entry) => entry.toolName === toolName).length;

    if (repeatedCount >= this.config.hardLimit) {
      return this.hardDecision(event, {
        reason: `Runtime loop guard interrupted repeated ${event.toolName} calls (${repeatedCount}/${this.config.hardLimit}) for the same structured arguments.`,
        kind: "repeated_tool_call",
        stableKey,
        count: repeatedCount,
      });
    }

    if (toolFrequency >= this.config.toolFrequencyHardLimit) {
      return this.hardDecision(event, {
        reason: `Runtime loop guard interrupted ${event.toolName} frequency (${toolFrequency}/${this.config.toolFrequencyHardLimit}) within the recent structured event window.`,
        kind: "tool_frequency",
        toolName,
        count: toolFrequency,
      });
    }

    if (repeatedCount >= this.config.warnThreshold && !this.warnedKeys.has(stableKey)) {
      this.warnedKeys.add(stableKey);
      return {
        action: "warn",
        guard: "runtime_loop_guard",
        reason: `Runtime loop guard warning: repeated ${event.toolName} calls (${repeatedCount}/${this.config.warnThreshold}) for the same structured arguments.`,
        event,
        metadata: { kind: "repeated_tool_call", stableKey, count: repeatedCount },
      };
    }

    if (toolFrequency >= this.config.toolFrequencyWarn && !this.warnedTools.has(toolName)) {
      this.warnedTools.add(toolName);
      return {
        action: "warn",
        guard: "runtime_loop_guard",
        reason: `Runtime loop guard warning: ${event.toolName} frequency (${toolFrequency}/${this.config.toolFrequencyWarn}) within the recent structured event window.`,
        event,
        metadata: { kind: "tool_frequency", toolName, count: toolFrequency },
      };
    }

    return none(event);
  }

  reset(): void {
    this.recent.length = 0;
    this.warnedKeys.clear();
    this.warnedTools.clear();
  }

  private hardDecision(
    event: AdapterRuntimeEvent,
    input: { reason: string; kind: string; count: number; stableKey?: string; toolName?: string },
  ): RuntimeGuardDecision {
    if (this.config.mode === "diagnostic") {
      return {
        action: "warn",
        guard: "runtime_loop_guard",
        reason: `${input.reason} Diagnostic mode only; process was not interrupted.`,
        event,
        metadata: input,
      };
    }
    return {
      action: "interrupt",
      guard: "runtime_loop_guard",
      reason: input.reason,
      event,
      metadata: input,
    };
  }
}

export function createRuntimeLoopDetector(
  config: Partial<RuntimeLoopGuardConfig> = {},
): RuntimeLoopDetector {
  return new RuntimeLoopDetector(config);
}

export function stableToolCallKey(event: Extract<AdapterRuntimeEvent, { type: "tool_call" }>): string {
  const toolName = normalizeToolName(event.toolName);
  const normalizedArgs = normalizeArgs(event.args);
  const salient = salientArgsForTool(toolName, normalizedArgs);
  return `${event.adapter}:${toolName}:${hashStable(salient)}`;
}

function none(event: AdapterRuntimeEvent): RuntimeGuardDecision {
  return { action: "none", guard: "runtime_loop_guard", reason: null, event };
}

function salientArgsForTool(toolName: string, args: unknown): unknown {
  const record = asRecord(args);
  if (!record) return args;

  if (isReadTool(toolName)) {
    const path = firstString(record, ["path", "file_path", "filepath", "file"]);
    const line = firstNumber(record, ["start_line", "startLine", "line", "offset", "from"]);
    const bucket = line === null ? null : Math.floor(Math.max(0, line - 1) / 200);
    return { path, bucket };
  }

  if (isWriteTool(toolName)) {
    const path = firstString(record, ["path", "file_path", "filepath", "file"]);
    const contentFields = pickExisting(record, [
      "content",
      "new_string",
      "old_string",
      "replacement",
      "patch",
      "diff",
      "edits",
      "input",
    ]);
    return {
      path,
      contentHash: hashStable(Object.keys(contentFields).length > 0 ? contentFields : record),
    };
  }

  const salient = pickExisting(record, [
    "command",
    "cmd",
    "url",
    "query",
    "path",
    "file_path",
    "pattern",
    "glob",
  ]);
  return Object.keys(salient).length > 0 ? salient : args;
}

function normalizeArgs(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return normalizeValue(JSON.parse(value));
    } catch {
      return { __malformedJsonString: value };
    }
  }
  return normalizeValue(value);
}

function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeValue);
    if (normalized.every(looksLikeToolCallObject)) {
      return normalized.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    }
    return normalized;
  }
  const source = value as Record<string, unknown>;
  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = normalizeValue(source[key]);
      return acc;
    }, {});
}

function looksLikeToolCallObject(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.name === "string" ||
    typeof record.toolName === "string" ||
    record.type === "tool_use" ||
    record.type === "function_call";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickExisting(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function isReadTool(toolName: string): boolean {
  return toolName === "read" || toolName === "read_file" || toolName === "view" || toolName.includes("read");
}

function isWriteTool(toolName: string): boolean {
  return [
    "write",
    "write_file",
    "edit",
    "str_replace",
    "apply_patch",
    "patch",
  ].some((name) => toolName === name || toolName.includes(name));
}

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}
