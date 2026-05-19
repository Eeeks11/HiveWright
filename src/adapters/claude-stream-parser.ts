/**
 * Pure parser for `claude --output-format stream-json --verbose --include-partial-messages` lines.
 *
 * Filters the raw event stream down to two things the dispatcher cares about:
 *   - text deltas (the assistant's natural-language output, token-by-token)
 *   - the terminal `result` envelope (final text + token usage)
 *
 * Everything else (thinking, signatures, hooks, assistant snapshots, rate-limit,
 * tool calls) is ignored. Tool-call rendering is intentionally out of scope for
 * Plan 4.5 — see the plan doc.
 */
import type { AdapterRuntimeEvent } from "../execution-guards";

export type ParsedStreamLine =
  | { kind: "text"; text: string }
  | { kind: "runtime_event"; event: AdapterRuntimeEvent }
  | {
      kind: "result";
      result: string;
      tokensInput?: number;
      freshInputTokens?: number;
      cachedInputTokens?: number;
      cacheCreationTokens?: number;
      cachedInputTokensKnown?: boolean;
      tokensOutput?: number;
      modelUsed?: string;
      isError: boolean;
      errorSubtype?: string;
    }
  | { kind: "ignore" };

interface RawEvent {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; text?: string; partial_json?: string };
    content_block?: {
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
  };
  result?: string;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export function parseStreamJsonLine(line: string): ParsedStreamLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };

  let parsed: RawEvent;
  try {
    parsed = JSON.parse(trimmed) as RawEvent;
  } catch {
    return { kind: "ignore" };
  }

  if (parsed.type === "stream_event" && parsed.event?.type === "content_block_delta") {
    const delta = parsed.event.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return { kind: "text", text: delta.text };
    }
    return { kind: "ignore" };
  }

  if (parsed.type === "stream_event" && parsed.event?.type === "content_block_start") {
    const block = parsed.event.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name.trim() !== "" && hasCompleteToolInput(block.input)) {
      return {
        kind: "runtime_event",
        event: {
          type: "tool_call",
          adapter: "claude-code",
          toolName: block.name,
          args: block.input,
          callId: typeof block.id === "string" ? block.id : null,
          source: "structured_stream",
          timestamp: new Date(),
        },
      };
    }
    return { kind: "ignore" };
  }

  if (parsed.type === "result") {
    const modelUsed = parsed.modelUsage ? Object.keys(parsed.modelUsage)[0] : undefined;
    const freshInputTokens =
      (parsed.usage?.input_tokens ?? 0) +
      (parsed.usage?.cache_creation_input_tokens ?? 0);
    const cachedInputTokens = parsed.usage?.cache_read_input_tokens;
    const cacheCreationTokens = parsed.usage?.cache_creation_input_tokens;
    const hasCacheMetadata =
      cacheCreationTokens !== undefined ||
      cachedInputTokens !== undefined;
    return {
      kind: "result",
      result: typeof parsed.result === "string" ? parsed.result : "",
      tokensInput: hasCacheMetadata
        ? freshInputTokens + (cachedInputTokens ?? 0)
        : parsed.usage?.input_tokens,
      ...(hasCacheMetadata
        ? {
            freshInputTokens,
            cachedInputTokens: cachedInputTokens ?? 0,
            cacheCreationTokens: cacheCreationTokens ?? 0,
            cachedInputTokensKnown: true,
          }
        : {}),
      tokensOutput: parsed.usage?.output_tokens,
      modelUsed,
      isError: parsed.is_error === true,
      errorSubtype: parsed.is_error === true ? parsed.subtype : undefined,
    };
  }

  return { kind: "ignore" };
}

function hasCompleteToolInput(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === "object" && !Array.isArray(input)) {
    return Object.keys(input as Record<string, unknown>).length > 0;
  }
  return true;
}

interface PendingToolUseBlock {
  id: string | null;
  name: string;
  input: unknown;
  partialJson: string;
}

function parseToolInputJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function parseStructuredLine(line: string): RawEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as RawEvent;
  } catch {
    return null;
  }
}

type ResultEvent = Extract<ParsedStreamLine, { kind: "result" }>;

export interface ChunkerOutput {
  texts: string[];
  runtimeEvents: AdapterRuntimeEvent[];
  /** Set on the first parsed `result` envelope; subsequent envelopes are ignored. */
  result: ResultEvent | null;
}

/**
 * Stateful line-buffer for stream-json output. Stdout chunks from the
 * subprocess can split on arbitrary byte boundaries — this class accumulates
 * partial bytes and only invokes `parseStreamJsonLine` on complete `\n`-
 * terminated lines.
 */
export class StreamJsonChunker {
  private buffer = "";
  private capturedResult: ResultEvent | null = null;
  private readonly pendingToolUseBlocks = new Map<number, PendingToolUseBlock>();

  feed(chunk: string): ChunkerOutput {
    this.buffer += chunk;
    const texts: string[] = [];
    const runtimeEvents: AdapterRuntimeEvent[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const structuredEvents = this.consumeStructuredToolEvents(line);
      runtimeEvents.push(...structuredEvents);
      const parsed = parseStreamJsonLine(line);
      if (parsed.kind === "text") texts.push(parsed.text);
      else if (parsed.kind === "runtime_event" && structuredEvents.length === 0) runtimeEvents.push(parsed.event);
      else if (parsed.kind === "result" && this.capturedResult === null) {
        this.capturedResult = parsed;
      }
    }
    return { texts, runtimeEvents, result: this.capturedResult };
  }

  private consumeStructuredToolEvents(line: string): AdapterRuntimeEvent[] {
    const parsed = parseStructuredLine(line);
    if (parsed?.type !== "stream_event") return [];
    const event = parsed.event;
    if (!event) return [];
    const index = typeof event.index === "number" ? event.index : -1;

    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type !== "tool_use" || typeof block.name !== "string" || block.name.trim() === "") {
        return [];
      }
      const pending: PendingToolUseBlock = {
        id: typeof block.id === "string" ? block.id : null,
        name: block.name,
        input: block.input ?? null,
        partialJson: "",
      };
      if (hasCompleteToolInput(block.input)) {
        return [this.buildToolEvent(pending, block.input)];
      }
      this.pendingToolUseBlocks.set(index, pending);
      return [];
    }

    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      const pending = this.pendingToolUseBlocks.get(index);
      if (pending && typeof event.delta.partial_json === "string") {
        pending.partialJson += event.delta.partial_json;
      }
      return [];
    }

    if (event.type === "content_block_stop") {
      const pending = this.pendingToolUseBlocks.get(index);
      this.pendingToolUseBlocks.delete(index);
      if (!pending) return [];
      const args = pending.partialJson
        ? parseToolInputJson(pending.partialJson)
        : pending.input;
      return args == null ? [] : [this.buildToolEvent(pending, args)];
    }

    return [];
  }

  private buildToolEvent(block: PendingToolUseBlock, args: unknown): AdapterRuntimeEvent {
    return {
      type: "tool_call",
      adapter: "claude-code",
      toolName: block.name,
      args,
      callId: block.id,
      source: "structured_stream",
      timestamp: new Date(),
    };
  }

  flush(): ChunkerOutput {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (!tail) return { texts: [], runtimeEvents: [], result: this.capturedResult };
    const texts: string[] = [];
    const runtimeEvents: AdapterRuntimeEvent[] = [];
    const structuredEvents = this.consumeStructuredToolEvents(tail);
    runtimeEvents.push(...structuredEvents);
    const parsed = parseStreamJsonLine(tail);
    if (parsed.kind === "text") texts.push(parsed.text);
    else if (parsed.kind === "runtime_event" && structuredEvents.length === 0) runtimeEvents.push(parsed.event);
    else if (parsed.kind === "result" && this.capturedResult === null) {
      this.capturedResult = parsed;
    }
    return { texts, runtimeEvents, result: this.capturedResult };
  }
}
