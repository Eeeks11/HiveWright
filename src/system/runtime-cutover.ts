import * as fs from "node:fs/promises";
import { resolveRuntimePath } from "@/runtime/paths";

export const RUNTIME_CUTOVER_FILENAME = "latest-runtime-cutover.json";

export type RuntimeMode = "locked-install" | "runtime-worktree";

export interface RuntimeCutoverServiceRecord {
  pid: number | null;
  cwd: string | null;
}

export interface RuntimeCutoverRecord {
  recordedAt: string | null;
  runtimeMode: RuntimeMode | null;
  installDir: string | null;
  runtimeRoot: string | null;
  envFile: string | null;
  dashboardHealthUrl: string | null;
  deployedCommit: string | null;
  buildHash: string | null;
  dashboard: RuntimeCutoverServiceRecord;
  dispatcher: RuntimeCutoverServiceRecord;
}

export interface RuntimeCutoverReadResult {
  path: string;
  record: RuntimeCutoverRecord | null;
  error: string | null;
}

export interface RuntimeCutoverStatus {
  path: string;
  available: boolean;
  state: "in_sync" | "drift" | "unavailable";
  reasons: string[];
  record: RuntimeCutoverRecord | null;
}

export interface RuntimeCutoverExpectation {
  installDir?: string | null;
  runtimeRoot?: string | null;
  envFile?: string | null;
  dashboardHealthUrl?: string | null;
  currentCommit?: string | null;
  currentBuildHash?: string | null;
  runtimeMode?: RuntimeMode | null;
}

type RuntimeCutoverSourceRecord = Partial<{
  recordedAt: unknown;
  completedAt: unknown;
  runtimeMode: unknown;
  installDir: unknown;
  runtimeCheckout: unknown;
  runtimeRoot: unknown;
  envFile: unknown;
  dashboardHealthUrl: unknown;
  deployedCommit: unknown;
  buildHash: unknown;
  dashboard: unknown;
  dispatcher: unknown;
}>;

export function resolveRuntimeCutoverPath(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
): string {
  return resolveRuntimePath(["logs", "deployments", RUNTIME_CUTOVER_FILENAME], env, repoRoot);
}

export async function readRuntimeCutoverRecord(options: {
  env?: { [key: string]: string | undefined };
  repoRoot?: string;
  cutoverPath?: string;
} = {}): Promise<RuntimeCutoverReadResult> {
  const cutoverPath = options.cutoverPath
    ?? resolveRuntimeCutoverPath(options.env ?? process.env, options.repoRoot ?? process.cwd());

  try {
    const raw = await fs.readFile(cutoverPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return {
      path: cutoverPath,
      record: normalizeRuntimeCutoverRecord(parsed),
      error: null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: cutoverPath,
        record: null,
        error: "Runtime cutover record has not been written yet.",
      };
    }
    return {
      path: cutoverPath,
      record: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function evaluateRuntimeCutover(
  input: RuntimeCutoverReadResult & { expected?: RuntimeCutoverExpectation },
): RuntimeCutoverStatus {
  if (!input.record) {
    return {
      path: input.path,
      available: false,
      state: "unavailable",
      reasons: input.error ? [input.error] : ["Runtime cutover record is unavailable."],
      record: null,
    };
  }

  const reasons: string[] = [];
  const expected = input.expected ?? {};
  const record = input.record;

  if (!record.runtimeMode) reasons.push("Runtime cutover record does not declare runtimeMode.");
  if (!record.installDir) reasons.push("Runtime cutover record does not declare installDir.");
  if (!record.runtimeRoot) reasons.push("Runtime cutover record does not declare runtimeRoot.");
  if (!record.recordedAt) reasons.push("Runtime cutover record does not declare recordedAt.");

  compareField(reasons, "runtimeMode", expected.runtimeMode ?? null, record.runtimeMode);
  compareField(reasons, "installDir", expected.installDir ?? null, record.installDir);
  compareField(reasons, "runtimeRoot", expected.runtimeRoot ?? null, record.runtimeRoot);
  compareField(reasons, "envFile", expected.envFile ?? null, record.envFile);
  compareField(reasons, "dashboardHealthUrl", expected.dashboardHealthUrl ?? null, record.dashboardHealthUrl);
  compareField(reasons, "deployedCommit", expected.currentCommit ?? null, record.deployedCommit);
  compareField(reasons, "buildHash", expected.currentBuildHash ?? null, record.buildHash);

  if (record.installDir && record.dashboard.cwd && record.dashboard.cwd !== record.installDir) {
    reasons.push(`dashboard cwd (${record.dashboard.cwd}) does not match installDir (${record.installDir})`);
  }
  if (record.installDir && record.dispatcher.cwd && record.dispatcher.cwd !== record.installDir) {
    reasons.push(`dispatcher cwd (${record.dispatcher.cwd}) does not match installDir (${record.installDir})`);
  }

  return {
    path: input.path,
    available: true,
    state: reasons.length === 0 ? "in_sync" : "drift",
    reasons,
    record,
  };
}

function compareField(reasons: string[], label: string, expected: string | null, actual: string | null) {
  if (!expected || !actual || expected === actual) return;
  reasons.push(`${label} drift: expected ${expected}, recorded ${actual}`);
}

function normalizeRuntimeCutoverRecord(value: unknown): RuntimeCutoverRecord {
  const record = isRecord(value) ? value as RuntimeCutoverSourceRecord : {};
  return {
    recordedAt: readString(record.recordedAt) ?? readString(record.completedAt),
    runtimeMode: readRuntimeMode(record.runtimeMode),
    installDir: readString(record.installDir) ?? readString(record.runtimeCheckout),
    runtimeRoot: readString(record.runtimeRoot),
    envFile: readString(record.envFile),
    dashboardHealthUrl: readString(record.dashboardHealthUrl),
    deployedCommit: readString(record.deployedCommit),
    buildHash: readString(record.buildHash),
    dashboard: readServiceRecord(record.dashboard),
    dispatcher: readServiceRecord(record.dispatcher),
  };
}

function readRuntimeMode(value: unknown): RuntimeMode | null {
  return value === "locked-install" || value === "runtime-worktree" ? value : null;
}

function readServiceRecord(value: unknown): RuntimeCutoverServiceRecord {
  if (!isRecord(value)) return { pid: null, cwd: null };
  return {
    pid: typeof value.pid === "number" ? value.pid : null,
    cwd: readString(value.cwd),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
