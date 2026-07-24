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
const DEFAULT_SHARED_CACHE_BYTE_CAP = 32 * 1024 * 1024 * 1024;

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "closed", "done", "archived"]);
const TERMINAL_GOAL_STATUSES = new Set(["achieved", "completed", "failed", "cancelled", "abandoned", "archived"]);

export type AgentEnvironmentScopeKind = "task" | "probe" | "goal-supervisor" | "shared-cache" | "unknown";
export type AgentEnvironmentScopeNameInput =
  | { kind: "task"; adapter: string; taskId: string }
  | { kind: "probe"; adapter: string; model: string }
  | { kind: "goal-supervisor"; adapter: string; goalId: string };

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
  sharedCacheByteCap: number;
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

export interface AgentEnvironmentLastCleanupResult {
  at: string;
  reclaimedBytes: number;
  deletedPaths: string[];
  reason: string;
}

let lastAgentEnvironmentCleanupResult: AgentEnvironmentLastCleanupResult | null = null;

export function getLastAgentEnvironmentCleanupResult(): AgentEnvironmentLastCleanupResult | null {
  return lastAgentEnvironmentCleanupResult;
}

export function setLastAgentEnvironmentCleanupResultForTests(value: AgentEnvironmentLastCleanupResult | null): void {
  lastAgentEnvironmentCleanupResult = value;
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
  sharedCacheByteCap: number;
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
    sharedCacheByteCap: input.sharedCacheByteCap ?? envBytes("HIVEWRIGHT_AGENT_ENV_SHARED_CACHE_BYTE_CAP", DEFAULT_SHARED_CACHE_BYTE_CAP),
  };
  return {
    ...config,
    buildSharedCacheEnv(base: Record<string, string | undefined> = {}) {
      fs.mkdirSync(path.join(sharedCacheRoot, "npm"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(sharedCacheRoot, "playwright"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(sharedCacheRoot, "huggingface", "hub"), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(sharedCacheRoot, "huggingface", "transformers"), { recursive: true, mode: 0o700 });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) env[key] = value;
      }
      env.npm_config_cache = path.join(sharedCacheRoot, "npm");
      env.PLAYWRIGHT_BROWSERS_PATH = path.join(sharedCacheRoot, "playwright");
      env.HF_HUB_CACHE = path.join(sharedCacheRoot, "huggingface", "hub");
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
  const result = { ...base, deleted: true, bytes };
  rememberCleanupResult([result], input.reason);
  return result;
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
    scopeName: scopeDirectoryName({ kind: "probe", adapter: input.adapter, model: input.model }),
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
  const scopeName = scopeDirectoryName({ kind: "task", taskId: input.taskId, adapter: input.adapter });
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
  const watermark = classifyDiskWatermark(before, config);

  const cleanup = await enforceAgentEnvironmentByteCaps({
    config,
    now: input.now,
    terminalStateChecker: input.terminalStateChecker,
    processInspector: input.processInspector,
  });

  if (watermark.mode === "hard" || watermark.mode === "warning") {
    const reclaimed = await reconcileAgentEnvironmentOrphans({
      runtimeRoot: config.runtimeRoot,
      dryRun: config.dryRun,
      now: input.now,
      retention: { taskGraceMs: config.taskGraceMs, goalGraceMs: config.goalGraceMs, probeGraceMs: config.probeGraceMs },
      terminalStateChecker: input.terminalStateChecker,
      processInspector: input.processInspector,
    });
    cleanup.deleted.push(...reclaimed.deleted);
    cleanup.skipped.push(...reclaimed.skipped);
  }

  const after = await stat(config.runtimeRoot);
  const finalWatermark = classifyDiskWatermark(after, config);

  if (finalWatermark.mode === "hard") {
    rememberCleanupResult(cleanup.deleted, cleanup.deleted.length > 0 ? "disk_pressure_hard_cleanup_attempt" : "disk_pressure_hard_stop");
    return {
      allowed: false,
      reason: formatDiskPressureReason(cleanup.deleted.length > 0 ? "disk_pressure_hard_cleanup_attempt" : "disk_pressure_hard_stop", finalWatermark, config),
      watermark: finalWatermark,
      cleanup: cleanup.deleted.length > 0 || cleanup.skipped.length > 0 ? cleanup : undefined,
    };
  }

  if (finalWatermark.mode === "warning") {
    rememberCleanupResult(cleanup.deleted, "disk_pressure_warning_cleanup");
    return { allowed: true, reason: formatDiskPressureReason("disk_pressure_warning_cleanup", finalWatermark, config), watermark: finalWatermark, cleanup };
  }

  rememberCleanupResult(cleanup.deleted, cleanup.deleted.length > 0 ? "disk_pressure_caps_enforced" : "disk_pressure_recovered");
  return cleanup.deleted.length > 0 || cleanup.skipped.length > 0
    ? { allowed: true, reason: "disk_pressure_caps_enforced", watermark: finalWatermark, cleanup }
    : { allowed: true, reason: "disk_pressure_recovered", watermark: finalWatermark };
}

function classifyDiskWatermark(stat: { freeBytes: number; totalBytes: number }, config: AgentEnvironmentLifecycleConfig): DiskWatermark {
  const freeRatio = stat.totalBytes > 0 ? stat.freeBytes / stat.totalBytes : 0;
  const mode = stat.freeBytes < config.hardFreeBytes || freeRatio < config.hardFreeRatio
    ? "hard"
    : stat.freeBytes < config.warningFreeBytes || freeRatio < config.warningFreeRatio
      ? "warning"
      : "ok";
  return { freeBytes: stat.freeBytes, totalBytes: stat.totalBytes, freeRatio, mode };
}

async function enforceAgentEnvironmentByteCaps(input: {
  config: AgentEnvironmentLifecycleConfig;
  now?: Date;
  terminalStateChecker?: AgentEnvironmentTerminalStateChecker;
  processInspector?: AgentEnvironmentProcessInspector;
}): Promise<{ deleted: CleanupEvidence[]; skipped: CleanupEvidence[] }> {
  const { config } = input;
  const entries = await listScopeEntries(config.runtimeRoot);
  const deleted: CleanupEvidence[] = [];
  const skipped: CleanupEvidence[] = [];

  const sharedEntries = await listScopeEntries(config.sharedCacheRoot);
  let sharedBytes = 0;
  const sharedSized = [] as Array<{ path: string; bytes: number; mtimeMs: number }>;
  for (const entry of sharedEntries) {
    const bytes = await directorySize(entry.path);
    const mtimeMs = entry.mtimeMs ?? await statMtimeMs(entry.path);
    sharedBytes += bytes;
    sharedSized.push({ path: entry.path, bytes, mtimeMs });
  }
  for (const entry of sharedSized.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (sharedBytes <= config.sharedCacheByteCap) break;
    const cleanup = await cleanupSharedCacheEntry({ config, entryPath: entry.path, reason: "shared_cache_byte_cap" });
    (cleanup.deleted ? deleted : skipped).push(cleanup);
    if (cleanup.deleted) sharedBytes -= entry.bytes;
  }

  const scoped = [] as Array<AgentEnvironmentScopeRef & { mtimeMs: number; bytes: number; reclaimable: boolean; proof?: string }>;
  for (const entry of entries) {
    const ref = parseScopePath(config.runtimeRoot, entry.path);
    if (!ref || ref.kind === "shared-cache" || ref.kind === "unknown") continue;
    const bytes = await directorySize(ref.path);
    const mtimeMs = entry.mtimeMs ?? await statMtimeMs(ref.path);
    let reclaimable = ref.kind === "probe";
    let proof = ref.kind === "probe" ? "probe scope is terminal after process exit" : undefined;
    if (!reclaimable) {
      const terminal = input.terminalStateChecker ? await input.terminalStateChecker(ref) : { terminal: false, proof: "no_db_checker" };
      proof = terminal.proof;
      const proc = input.processInspector ? await input.processInspector(ref.path) : await defaultProcessInspector(ref.path);
      reclaimable = terminal.terminal && !proc.referenced;
      if (terminal.terminal && proc.referenced) skipped.push({ path: ref.path, reason: "byte_cap", dryRun: config.dryRun, deleted: false, bytes, skippedReason: "active_process_reference", proof, pids: proc.pids });
    }
    scoped.push({ ...ref, bytes, mtimeMs, reclaimable, proof });
  }

  for (const ref of scoped) {
    if (ref.bytes <= config.perScopeByteCap || !ref.reclaimable) continue;
    const cleanup = await cleanupAgentEnvironmentScope({ runtimeRoot: config.runtimeRoot, scopePath: ref.path, dryRun: config.dryRun, reason: "per_scope_byte_cap", proof: ref.proof });
    (cleanup.deleted ? deleted : skipped).push(cleanup);
  }

  const afterPerScope = await listScopeEntries(config.runtimeRoot);
  const remaining = [] as Array<AgentEnvironmentScopeRef & { mtimeMs: number; bytes: number; reclaimable: boolean; proof?: string }>;
  let totalBytes = await directorySize(config.sharedCacheRoot);
  for (const entry of afterPerScope) {
    const ref = parseScopePath(config.runtimeRoot, entry.path);
    if (!ref || ref.kind === "shared-cache" || ref.kind === "unknown") continue;
    const bytes = await directorySize(ref.path);
    totalBytes += bytes;
    let reclaimable = ref.kind === "probe";
    let proof = ref.kind === "probe" ? "probe scope is terminal after process exit" : undefined;
    if (!reclaimable) {
      const terminal = input.terminalStateChecker ? await input.terminalStateChecker(ref) : { terminal: false, proof: "no_db_checker" };
      const proc = input.processInspector ? await input.processInspector(ref.path) : await defaultProcessInspector(ref.path);
      reclaimable = terminal.terminal && !proc.referenced;
      proof = terminal.proof;
    }
    remaining.push({ ...ref, bytes, mtimeMs: entry.mtimeMs ?? await statMtimeMs(ref.path), reclaimable, proof });
  }
  for (const ref of remaining.filter((item) => item.reclaimable).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= config.globalByteCap) break;
    const cleanup = await cleanupAgentEnvironmentScope({ runtimeRoot: config.runtimeRoot, scopePath: ref.path, dryRun: config.dryRun, reason: "global_byte_cap", proof: ref.proof });
    (cleanup.deleted ? deleted : skipped).push(cleanup);
    if (cleanup.deleted) totalBytes -= ref.bytes;
  }
  return { deleted, skipped };
}

async function cleanupSharedCacheEntry(input: { config: AgentEnvironmentLifecycleConfig; entryPath: string; reason: string }): Promise<CleanupEvidence> {
  const entryPath = path.resolve(input.entryPath);
  const base: CleanupEvidence = { path: entryPath, reason: input.reason, dryRun: input.config.dryRun, deleted: false, bytes: await directorySize(entryPath) };
  const sharedRootReal = await realpathOrNull(input.config.sharedCacheRoot);
  const entryReal = await realpathOrNull(entryPath);
  const stat = await lstatOrNull(entryPath);
  if (!sharedRootReal) return { ...base, skippedReason: "shared_cache_missing" };
  if (!entryReal || !stat) return { ...base, skippedReason: "scope_missing" };
  if (stat.isSymbolicLink() || !pathWithin(entryReal, sharedRootReal) || entryReal === sharedRootReal) return { ...base, skippedReason: "outside_shared_cache" };
  if (input.config.dryRun) return base;
  await fsp.rm(entryPath, { recursive: true, force: false });
  return { ...base, deleted: true };
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
  const task = parseDelimitedScopeName(name, "task");
  if (task) return { kind: "task", scopeId: task.scopeId, adapter: task.adapter, path: resolvedPath };
  const probe = parseDelimitedScopeName(name, "probe");
  if (probe) return { kind: "probe", scopeId: probe.scopeId, adapter: probe.adapter, path: resolvedPath };
  const goal = parseDelimitedScopeName(name, "goal");
  if (goal) return { kind: "goal-supervisor", scopeId: goal.scopeId, adapter: goal.adapter, path: resolvedPath };
  return { kind: "unknown", scopeId: name, adapter: null, path: resolvedPath };
}

export function scopeDirectoryName(scope: AgentEnvironmentScopeNameInput): string {
  if (scope.kind === "task") return `task-${safeSegment(scope.taskId)}--${safeSegment(scope.adapter)}`;
  if (scope.kind === "goal-supervisor") return `goal-${safeSegment(scope.goalId)}--${safeSegment(scope.adapter)}`;
  return `probe-${safeSegment(scope.adapter)}--${safeSegment(scope.model)}`;
}

function parseDelimitedScopeName(name: string, prefix: "task" | "probe" | "goal"): { scopeId: string; adapter: string } | null {
  const body = name.startsWith(`${prefix}-`) ? name.slice(prefix.length + 1) : null;
  if (!body) return null;
  const delimiter = body.lastIndexOf("--");
  if (delimiter >= 0) {
    const left = body.slice(0, delimiter);
    const right = body.slice(delimiter + 2);
    if (left && right) {
      return prefix === "probe"
        ? { adapter: left, scopeId: right }
        : { scopeId: left, adapter: right };
    }
  }
  const knownAdapters = ["claude-code", "openai-codex", "openclaw-session", "openclaw", "gemini", "codex", "ollama"];
  for (const adapter of knownAdapters.sort((a, b) => b.length - a.length)) {
    const suffix = `-${adapter}`;
    if ((prefix === "task" || prefix === "goal") && body.endsWith(suffix) && body.length > suffix.length) {
      return { scopeId: body.slice(0, -suffix.length), adapter };
    }
    const prefixText = `${adapter}-`;
    if (prefix === "probe" && body.startsWith(prefixText) && body.length > prefixText.length) {
      return { adapter, scopeId: body.slice(prefixText.length) };
    }
  }
  const legacy = prefix === "probe" ? body.match(/^(.+)-(.+)$/) : body.match(/^(.+)-([^-]+)$/);
  if (!legacy) return null;
  return prefix === "probe"
    ? { adapter: legacy[1], scopeId: legacy[2] }
    : { scopeId: legacy[1], adapter: legacy[2] };
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

function rememberCleanupResult(results: CleanupEvidence[], reason: string): void {
  const deleted = results.filter((result) => result.deleted === true);
  if (deleted.length === 0) return;
  lastAgentEnvironmentCleanupResult = {
    at: new Date().toISOString(),
    reclaimedBytes: deleted.reduce((sum, result) => sum + result.bytes, 0),
    deletedPaths: deleted.map((result) => result.path),
    reason,
  };
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
