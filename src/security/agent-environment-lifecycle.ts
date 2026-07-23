import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import type { Sql } from "postgres";

const DEFAULT_WARNING_FREE_RATIO = 0.15;
const DEFAULT_HARD_FREE_RATIO = 0.08;
const DEFAULT_WARNING_FREE_BYTES = 50 * 1024 * 1024 * 1024;
const DEFAULT_HARD_FREE_BYTES = 25 * 1024 * 1024 * 1024;
const DEFAULT_TASK_GRACE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GOAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PROBE_GRACE_MS = 0;
const DEFAULT_GLOBAL_BYTE_CAP = 160 * 1024 * 1024 * 1024;
const DEFAULT_PER_SCOPE_BYTE_CAP = 4 * 1024 * 1024 * 1024;

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "closed", "done", "archived"]);
const TERMINAL_GOAL_STATUSES = new Set(["achieved", "completed", "failed", "cancelled", "abandoned", "archived"]);

export type AgentEnvironmentScopeKind = "task" | "probe" | "goal-supervisor" | "shared-cache" | "unknown";

export interface AgentEnvironmentLifecycleConfig {
  runtimeRoot: string;
  sharedCacheRoot: string;
  dryRun: boolean;
  warningFreeRatio: number;
  warningFreeBytes: number;
  hardFreeRatio: number;
  hardFreeBytes: number;
  taskGraceMs: number;
  goalGraceMs: number;
  probeGraceMs: number;
  globalByteCap: number;
  perScopeByteCap: number;
  buildSharedCacheEnv(base?: Record<string, string | undefined>): Record<string, string>;
}

export interface AgentEnvironmentScopeRef {
  kind: AgentEnvironmentScopeKind;
  scopeId: string;
  adapter: string | null;
  path: string;
  bytes?: number;
  mtimeMs?: number;
}

export interface CleanupEvidence {
  path: string;
  reason: string;
  dryRun: boolean;
  deleted: boolean;
  bytes: number;
  skippedReason?: string;
  proof?: string;
  pids?: number[];
}

export type AgentEnvironmentTerminalStateChecker = (scope: AgentEnvironmentScopeRef) => Promise<{ terminal: boolean; proof: string }>;
export type AgentEnvironmentProcessInspector = (scopePath: string) => Promise<{ referenced: boolean; pids: number[] }>;

export function buildAgentEnvironmentLifecycleConfig(input: Partial<{
  runtimeRoot: string;
  dryRun: boolean;
  warningFreeRatio: number;
  warningFreeBytes: number;
  hardFreeRatio: number;
  hardFreeBytes: number;
  taskGraceMs: number;
  goalGraceMs: number;
  probeGraceMs: number;
  globalByteCap: number;
  perScopeByteCap: number;
}> = {}): AgentEnvironmentLifecycleConfig {
  const runtimeRoot = path.resolve(input.runtimeRoot ?? defaultRuntimeRoot());
  const sharedCacheRoot = path.join(runtimeRoot, "_shared-cache");
  const config = {
    runtimeRoot,
    sharedCacheRoot,
    dryRun: input.dryRun ?? envBool("HIVEWRIGHT_AGENT_ENV_CLEANUP_DRY_RUN", false),
    warningFreeRatio: input.warningFreeRatio ?? envNumber("HIVEWRIGHT_AGENT_ENV_WARNING_FREE_RATIO", DEFAULT_WARNING_FREE_RATIO),
    warningFreeBytes: input.warningFreeBytes ?? envBytes("HIVEWRIGHT_AGENT_ENV_WARNING_FREE_BYTES", DEFAULT_WARNING_FREE_BYTES),
    hardFreeRatio: input.hardFreeRatio ?? envNumber("HIVEWRIGHT_AGENT_ENV_HARD_FREE_RATIO", DEFAULT_HARD_FREE_RATIO),
    hardFreeBytes: input.hardFreeBytes ?? envBytes("HIVEWRIGHT_AGENT_ENV_HARD_FREE_BYTES", DEFAULT_HARD_FREE_BYTES),
    taskGraceMs: input.taskGraceMs ?? envDurationMs("HIVEWRIGHT_AGENT_ENV_TASK_GRACE_MS", DEFAULT_TASK_GRACE_MS),
    goalGraceMs: input.goalGraceMs ?? envDurationMs("HIVEWRIGHT_AGENT_ENV_GOAL_GRACE_MS", DEFAULT_GOAL_GRACE_MS),
    probeGraceMs: input.probeGraceMs ?? envDurationMs("HIVEWRIGHT_AGENT_ENV_PROBE_GRACE_MS", DEFAULT_PROBE_GRACE_MS),
    globalByteCap: input.globalByteCap ?? envBytes("HIVEWRIGHT_AGENT_ENV_GLOBAL_BYTE_CAP", DEFAULT_GLOBAL_BYTE_CAP),
    perScopeByteCap: input.perScopeByteCap ?? envBytes("HIVEWRIGHT_AGENT_ENV_PER_SCOPE_BYTE_CAP", DEFAULT_PER_SCOPE_BYTE_CAP),
  };
  return {
    ...config,
    buildSharedCacheEnv(base: Record<string, string | undefined> = {}) {
      fs.mkdirSync(path.join(sharedCacheRoot, "npm"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(sharedCacheRoot, "playwright"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(sharedCacheRoot, "huggingface", "transformers"), { recursive: true, mode: 0o700 });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) env[key] = value;
      }
      env.npm_config_cache = path.join(sharedCacheRoot, "npm");
      env.PLAYWRIGHT_BROWSERS_PATH = path.join(sharedCacheRoot, "playwright");
      env.HF_HOME = path.join(sharedCacheRoot, "huggingface");
      env.TRANSFORMERS_CACHE = path.join(sharedCacheRoot, "huggingface", "transformers");
      return env;
    },
  };
}

export async function cleanupAgentEnvironmentScope(input: {
  runtimeRoot: string;
  scopePath: string;
  dryRun?: boolean;
  reason: string;
  proof?: string;
}): Promise<CleanupEvidence> {
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const scopePath = path.resolve(input.scopePath);
  const base: CleanupEvidence = {
    path: scopePath,
    reason: input.reason,
    dryRun: input.dryRun ?? false,
    deleted: false,
    bytes: 0,
    proof: input.proof,
  };

  const validation = await validateDeletableScope(runtimeRoot, scopePath);
  if (validation.ok !== true) return { ...base, skippedReason: validation.reason };
  const bytes = await directorySize(scopePath);
  if (base.dryRun) return { ...base, bytes };
  await fsp.rm(scopePath, { recursive: true, force: false });
  return { ...base, deleted: true, bytes };
}

export async function cleanupAgentEnvironmentScopeByName(input: {
  runtimeRoot?: string;
  scopeName: string;
  dryRun?: boolean;
  reason: string;
  proof?: string;
}): Promise<CleanupEvidence> {
  const runtimeRoot = path.resolve(input.runtimeRoot ?? defaultRuntimeRoot());
  return cleanupAgentEnvironmentScope({
    runtimeRoot,
    scopePath: path.join(runtimeRoot, input.scopeName),
    dryRun: input.dryRun ?? buildAgentEnvironmentLifecycleConfig({ runtimeRoot }).dryRun,
    reason: input.reason,
    proof: input.proof,
  });
}

export async function cleanupProbeAgentEnvironment(input: {
  adapter: string;
  model: string;
  runtimeRoot?: string;
  dryRun?: boolean;
  reason?: string;
}): Promise<CleanupEvidence> {
  const runtimeRoot = path.resolve(input.runtimeRoot ?? defaultRuntimeRoot());
  return cleanupAgentEnvironmentScopeByName({
    runtimeRoot,
    scopeName: `probe-${safeSegment(input.adapter)}-${safeSegment(input.model)}`,
    dryRun: input.dryRun,
    reason: input.reason ?? "probe_terminal",
    proof: "adapter probe returned",
  });
}

export async function cleanupTaskAgentEnvironmentIfTerminal(sql: Sql, input: {
  taskId: string;
  adapter: string;
  runtimeRoot?: string;
  dryRun?: boolean;
  now?: Date;
  graceMs?: number;
}): Promise<CleanupEvidence | null> {
  const config = buildAgentEnvironmentLifecycleConfig({ runtimeRoot: input.runtimeRoot, dryRun: input.dryRun, taskGraceMs: input.graceMs });
  const scopeName = `task-${safeSegment(input.taskId)}-${safeSegment(input.adapter)}`;
  const scopePath = path.join(config.runtimeRoot, scopeName);
  const ref: AgentEnvironmentScopeRef = { kind: "task", scopeId: input.taskId, adapter: input.adapter, path: scopePath };
  const terminal = await defaultTerminalStateChecker(sql)(ref);
  if (!terminal.terminal) return null;
  const ageOk = await olderThan(scopePath, input.now ?? new Date(), config.taskGraceMs);
  if (!ageOk) return null;
  const proc = await defaultProcessInspector(scopePath);
  if (proc.referenced) return { path: scopePath, reason: "task_terminal", dryRun: config.dryRun, deleted: false, bytes: await directorySize(scopePath), skippedReason: "active_process_reference", pids: proc.pids, proof: terminal.proof };
  return cleanupAgentEnvironmentScope({ runtimeRoot: config.runtimeRoot, scopePath, dryRun: config.dryRun, reason: "task_terminal", proof: terminal.proof });
}

export async function reconcileAgentEnvironmentOrphans(input: {
  runtimeRoot: string;
  dryRun?: boolean;
  now?: Date;
  retention?: Partial<{ taskGraceMs: number; goalGraceMs: number; probeGraceMs: number }>;
  entries?: Array<{ path: string; mtimeMs?: number }>;
  terminalStateChecker?: AgentEnvironmentTerminalStateChecker;
  processInspector?: AgentEnvironmentProcessInspector;
}): Promise<{ deleted: CleanupEvidence[]; skipped: CleanupEvidence[] }> {
  const now = input.now ?? new Date();
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const entries = input.entries ?? await listScopeEntries(runtimeRoot);
  const terminalStateChecker = input.terminalStateChecker ?? (() => Promise.resolve({ terminal: false, proof: "no_db_checker" }));
  const processInspector = input.processInspector ?? defaultProcessInspector;
  const deleted: CleanupEvidence[] = [];
  const skipped: CleanupEvidence[] = [];

  for (const entry of entries) {
    const ref = parseScopePath(runtimeRoot, entry.path);
    if (!ref || ref.kind === "shared-cache" || ref.kind === "unknown") continue;
    ref.mtimeMs = entry.mtimeMs;
    ref.bytes = await directorySize(ref.path);
    const grace = ref.kind === "task"
      ? input.retention?.taskGraceMs ?? DEFAULT_TASK_GRACE_MS
      : ref.kind === "goal-supervisor"
        ? input.retention?.goalGraceMs ?? DEFAULT_GOAL_GRACE_MS
        : input.retention?.probeGraceMs ?? DEFAULT_PROBE_GRACE_MS;
    const ageMs = now.getTime() - (entry.mtimeMs ?? (await statMtimeMs(ref.path)));
    if (ageMs < grace) {
      skipped.push({ path: ref.path, reason: "orphan_reconcile", dryRun: input.dryRun ?? false, deleted: false, bytes: ref.bytes, skippedReason: "within_grace_period" });
      continue;
    }
    const terminal = ref.kind === "probe" ? { terminal: true, proof: "probe scope is terminal after process exit" } : await terminalStateChecker(ref);
    if (!terminal.terminal) {
      skipped.push({ path: ref.path, reason: "orphan_reconcile", dryRun: input.dryRun ?? false, deleted: false, bytes: ref.bytes, skippedReason: "non_terminal_db_state", proof: terminal.proof });
      continue;
    }
    const processRef = await processInspector(ref.path);
    if (processRef.referenced) {
      skipped.push({ path: ref.path, reason: "orphan_reconcile", dryRun: input.dryRun ?? false, deleted: false, bytes: ref.bytes, skippedReason: "active_process_reference", proof: terminal.proof, pids: processRef.pids });
      continue;
    }
    const cleanup = await cleanupAgentEnvironmentScope({ runtimeRoot, scopePath: ref.path, dryRun: input.dryRun ?? false, reason: "orphan_reconcile", proof: terminal.proof });
    (cleanup.deleted ? deleted : skipped).push(cleanup);
  }
  return { deleted, skipped };
}

export async function collectAgentEnvironmentInventory(input: {
  runtimeRoot: string;
  now?: Date;
  entries?: Array<{ path: string; mtimeMs?: number }>;
  terminalStateChecker?: AgentEnvironmentTerminalStateChecker;
  processInspector?: AgentEnvironmentProcessInspector;
  lastCleanup?: { at: string; reclaimedBytes: number; deletedPaths: string[] };
  watermark?: DiskWatermark;
}) {
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const now = input.now ?? new Date();
  const entries = input.entries ?? await listScopeEntries(runtimeRoot);
  const counts = { task: 0, probe: 0, goalSupervisor: 0, sharedCache: 0, unknown: 0, total: 0 };
  let total = 0;
  let reclaimable = 0;
  let oldestMs = 0;
  for (const entry of entries) {
    const ref = parseScopePath(runtimeRoot, entry.path);
    if (!ref) continue;
    const bytes = await directorySize(ref.path);
    total += bytes;
    counts.total += 1;
    if (ref.kind === "task") counts.task += 1;
    else if (ref.kind === "probe") counts.probe += 1;
    else if (ref.kind === "goal-supervisor") counts.goalSupervisor += 1;
    else if (ref.kind === "shared-cache") counts.sharedCache += 1;
    else counts.unknown += 1;
    const mtimeMs = entry.mtimeMs ?? await statMtimeMs(ref.path);
    oldestMs = Math.max(oldestMs, now.getTime() - mtimeMs);
    if (ref.kind === "probe") reclaimable += bytes;
    else if (ref.kind === "task" || ref.kind === "goal-supervisor") {
      const terminal = input.terminalStateChecker ? await input.terminalStateChecker(ref) : { terminal: false };
      const proc = input.processInspector ? await input.processInspector(ref.path) : { referenced: false };
      if (terminal.terminal && !proc.referenced) reclaimable += bytes;
    }
  }
  return {
    runtimeRoot,
    counts,
    bytes: { total, reclaimable },
    age: { oldestMs },
    watermark: input.watermark ?? null,
    lastCleanup: input.lastCleanup ?? null,
  };
}

export interface DiskWatermark { freeBytes: number; totalBytes: number; freeRatio: number; mode: "ok" | "warning" | "hard" }

export async function checkAgentEnvironmentDiskPressure(input: {
  config?: AgentEnvironmentLifecycleConfig;
  now?: Date;
  statfs?: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  terminalStateChecker?: AgentEnvironmentTerminalStateChecker;
  processInspector?: AgentEnvironmentProcessInspector;
}): Promise<{ allowed: boolean; reason: string; watermark: DiskWatermark; cleanup?: { deleted: CleanupEvidence[]; skipped: CleanupEvidence[] } }> {
  const config = input.config ?? buildAgentEnvironmentLifecycleConfig();
  const stat = input.statfs ?? defaultStatfs;
  const before = await stat(config.runtimeRoot);
  const freeRatio = before.totalBytes > 0 ? before.freeBytes / before.totalBytes : 0;
  const mode = before.freeBytes < config.hardFreeBytes || freeRatio < config.hardFreeRatio
    ? "hard"
    : before.freeBytes < config.warningFreeBytes || freeRatio < config.warningFreeRatio
      ? "warning"
      : "ok";
  const watermark: DiskWatermark = { freeBytes: before.freeBytes, totalBytes: before.totalBytes, freeRatio, mode };
  if (mode === "hard") {
    return { allowed: false, reason: formatDiskPressureReason("disk_pressure_hard_stop", watermark, config), watermark };
  }
  if (mode === "warning") {
    const cleanup = await reconcileAgentEnvironmentOrphans({
      runtimeRoot: config.runtimeRoot,
      dryRun: config.dryRun,
      now: input.now,
      retention: { taskGraceMs: config.taskGraceMs, goalGraceMs: config.goalGraceMs, probeGraceMs: config.probeGraceMs },
      terminalStateChecker: input.terminalStateChecker,
      processInspector: input.processInspector,
    });
    return { allowed: true, reason: formatDiskPressureReason("disk_pressure_warning_cleanup", watermark, config), watermark, cleanup };
  }
  return { allowed: true, reason: "disk_pressure_recovered", watermark };
}

export function simulateAgentEnvironmentRetention(input: {
  days: number;
  dailyScopes: { probes: number; tasks: number; goalSupervisors: number };
  perScopeBytes: { probe: number; task: number; goalSupervisor: number };
  sharedCacheBytes: number;
  diskTotalBytes: number;
  hardFreeBytes: number;
  hardFreeRatio: number;
  retention: { taskGraceDays: number; goalGraceDays: number; probeGraceDays: number };
  globalByteCap: number;
  perScopeByteCap: number;
}) {
  let minimumFreeBytes = input.diskTotalBytes;
  let agentBytes = input.sharedCacheBytes;
  const hardWatermarkBytes = Math.max(input.hardFreeBytes, input.diskTotalBytes * input.hardFreeRatio);
  for (let day = 1; day <= input.days; day++) {
    const probeDays = Math.min(day, Math.max(0, input.retention.probeGraceDays));
    const taskDays = Math.min(day, Math.max(0, input.retention.taskGraceDays));
    const goalDays = Math.min(day, Math.max(0, input.retention.goalGraceDays));
    agentBytes = input.sharedCacheBytes
      + probeDays * input.dailyScopes.probes * Math.min(input.perScopeBytes.probe, input.perScopeByteCap)
      + taskDays * input.dailyScopes.tasks * Math.min(input.perScopeBytes.task, input.perScopeByteCap)
      + goalDays * input.dailyScopes.goalSupervisors * Math.min(input.perScopeBytes.goalSupervisor, input.perScopeByteCap);
    agentBytes = Math.min(agentBytes, input.globalByteCap);
    minimumFreeBytes = Math.min(minimumFreeBytes, input.diskTotalBytes - agentBytes);
  }
  return { minimumFreeBytes, hardWatermarkBytes, finalAgentEnvironmentBytes: agentBytes };
}

export function parseScopePath(runtimeRoot: string, scopePath: string): AgentEnvironmentScopeRef | null {
  const resolvedRoot = path.resolve(runtimeRoot);
  const resolvedPath = path.resolve(scopePath);
  if (!pathWithin(resolvedPath, resolvedRoot)) return null;
  const name = path.basename(resolvedPath);
  if (name === "_shared-cache") return { kind: "shared-cache", scopeId: name, adapter: null, path: resolvedPath };
  const task = name.match(/^task-(.+)-([^-]+)$/);
  if (task) return { kind: "task", scopeId: task[1], adapter: task[2], path: resolvedPath };
  const probe = name.match(/^probe-(.+)-(.+)$/);
  if (probe) return { kind: "probe", scopeId: probe[2], adapter: probe[1], path: resolvedPath };
  const goal = name.match(/^goal-(.+)-([^-]+)$/);
  if (goal) return { kind: "goal-supervisor", scopeId: goal[1], adapter: goal[2], path: resolvedPath };
  return { kind: "unknown", scopeId: name, adapter: null, path: resolvedPath };
}

export function defaultTerminalStateChecker(sql: Sql): AgentEnvironmentTerminalStateChecker {
  return async (scope) => {
    if (scope.kind === "probe") return { terminal: true, proof: "probe scope" };
    if (scope.kind === "task") {
      const rows = await sql<{ status: string | null }[]>`SELECT status FROM tasks WHERE id = ${scope.scopeId} LIMIT 1`;
      const status = rows[0]?.status ?? null;
      return { terminal: !!status && TERMINAL_TASK_STATUSES.has(status), proof: status ? `tasks.status=${status}` : "task row missing" };
    }
    if (scope.kind === "goal-supervisor") {
      const rows = await sql<{ status: string | null; supervisor_status: string | null }[]>`
        SELECT status, supervisor_status FROM goals WHERE id = ${scope.scopeId} LIMIT 1
      `;
      const row = rows[0];
      const terminal = !!row && TERMINAL_GOAL_STATUSES.has(String(row.status)) && row.supervisor_status !== "running";
      return { terminal, proof: row ? `goals.status=${row.status};supervisor_status=${row.supervisor_status}` : "goal row missing" };
    }
    return { terminal: false, proof: "unknown scope" };
  };
}

export async function defaultProcessInspector(scopePath: string): Promise<{ referenced: boolean; pids: number[] }> {
  const pids: number[] = [];
  const resolvedScope = path.resolve(scopePath);
  let procEntries: string[] = [];
  try { procEntries = await fsp.readdir("/proc"); } catch { return { referenced: false, pids }; }
  await Promise.all(procEntries.filter((name) => /^\d+$/.test(name)).map(async (pidText) => {
    const pid = Number(pidText);
    const candidates = [`/proc/${pidText}/cwd`, `/proc/${pidText}/root`];
    for (const candidate of candidates) {
      try {
        const target = await fsp.realpath(candidate);
        if (pathWithin(target, resolvedScope)) {
          pids.push(pid);
          return;
        }
      } catch { /* ignore dead/inaccessible proc rows */ }
    }
    try {
      const environ = await fsp.readFile(`/proc/${pidText}/environ`, "utf8");
      if (environ.includes(resolvedScope)) pids.push(pid);
    } catch { /* ignore */ }
  }));
  return { referenced: pids.length > 0, pids: Array.from(new Set(pids)).sort((a, b) => a - b) };
}

async function validateDeletableScope(runtimeRoot: string, scopePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rootReal = await realpathOrNull(runtimeRoot);
  if (!rootReal) return { ok: false, reason: "runtime_root_missing" };
  const lstat = await lstatOrNull(scopePath);
  if (!lstat) return { ok: false, reason: "scope_missing" };
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) return { ok: false, reason: "not_real_directory" };
  const real = await realpathOrNull(scopePath);
  if (!real || !pathWithin(real, rootReal)) return { ok: false, reason: "outside_runtime_root" };
  if (path.basename(real) === "_shared-cache") return { ok: false, reason: "shared_cache_not_scope" };
  return { ok: true };
}

async function directorySize(target: string): Promise<number> {
  const lstat = await lstatOrNull(target);
  if (!lstat) return 0;
  if (lstat.isSymbolicLink()) return 0;
  if (!lstat.isDirectory()) return lstat.size;
  let total = lstat.size;
  let entries: string[] = [];
  try { entries = await fsp.readdir(target); } catch { return total; }
  for (const entry of entries) total += await directorySize(path.join(target, entry));
  return total;
}

async function listScopeEntries(runtimeRoot: string): Promise<Array<{ path: string; mtimeMs?: number }>> {
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(runtimeRoot, { withFileTypes: true }); } catch { return []; }
  return Promise.all(entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map(async (entry) => ({ path: path.join(runtimeRoot, entry.name), mtimeMs: await statMtimeMs(path.join(runtimeRoot, entry.name)) })));
}

async function olderThan(scopePath: string, now: Date, graceMs: number): Promise<boolean> {
  if (graceMs <= 0) return true;
  const mtimeMs = await statMtimeMs(scopePath);
  return now.getTime() - mtimeMs >= graceMs;
}

async function statMtimeMs(scopePath: string): Promise<number> {
  const stat = await lstatOrNull(scopePath);
  return stat?.mtimeMs ?? 0;
}

function defaultRuntimeRoot(): string {
  return process.env.HIVEWRIGHT_RUNTIME_ROOT
    ? path.join(process.env.HIVEWRIGHT_RUNTIME_ROOT, "agent-environments")
    : path.join(process.cwd(), ".hivewright-agent-runtime");
}

async function defaultStatfs(target: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const stats = await fsp.statfs(target).catch(async () => {
    await fsp.mkdir(target, { recursive: true });
    return fsp.statfs(target);
  });
  return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
}

function formatDiskPressureReason(prefix: string, watermark: DiskWatermark, config: AgentEnvironmentLifecycleConfig): string {
  return `${prefix}: free=${watermark.freeBytes} total=${watermark.totalBytes} ratio=${watermark.freeRatio.toFixed(4)} hard_bytes=${config.hardFreeBytes} hard_ratio=${config.hardFreeRatio} warning_bytes=${config.warningFreeBytes} warning_ratio=${config.warningFreeRatio}`;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (safe || "unknown").slice(0, 160);
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrNull(target: string): Promise<string | null> {
  try { return await fsp.realpath(target); } catch { return null; }
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try { return await fsp.lstat(target); } catch { return null; }
}

function envNumber(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBytes(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = value.match(/^(\d+(?:\.\d+)?)([kmgt]i?b?)?$/i);
  if (!parsed) return fallback;
  const number = Number(parsed[1]);
  const unit = (parsed[2] ?? "").toLowerCase();
  const multiplier = unit.startsWith("t") ? 1024 ** 4 : unit.startsWith("g") ? 1024 ** 3 : unit.startsWith("m") ? 1024 ** 2 : unit.startsWith("k") ? 1024 : 1;
  return Math.floor(number * multiplier);
}

function envDurationMs(key: string, fallback: number): number {
  return envBytes(key, fallback);
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}
