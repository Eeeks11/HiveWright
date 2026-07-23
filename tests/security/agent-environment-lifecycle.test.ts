import { mkdir, readFile, rm, symlink, utimes, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentEnvironmentLifecycleConfig,
  checkAgentEnvironmentDiskPressure,
  cleanupAgentEnvironmentScope,
  collectAgentEnvironmentInventory,
  reconcileAgentEnvironmentOrphans,
  simulateAgentEnvironmentRetention,
  parseScopePath,
  type AgentEnvironmentProcessInspector,
  type AgentEnvironmentTerminalStateChecker,
} from "@/security/agent-environment-lifecycle";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(tmpdir(), `hw-agent-lifecycle-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

async function createScope(root: string, name: string, bytes = 10): Promise<string> {
  const scope = path.join(root, name);
  await mkdir(path.join(scope, "home", ".npm"), { recursive: true });
  await writeFile(path.join(scope, "home", ".npm", "payload.bin"), Buffer.alloc(bytes, "a"));
  return scope;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent environment lifecycle", () => {
  it("shares only safe bounded cache paths while preserving isolated HOME/session roots", async () => {
    const root = await tempRoot();
    const env = buildAgentEnvironmentLifecycleConfig({ runtimeRoot: root }).buildSharedCacheEnv({});

    expect(env.npm_config_cache).toBe(path.join(root, "_shared-cache", "npm"));
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(path.join(root, "_shared-cache", "playwright"));
    expect(env.HF_HOME).toBe(path.join(root, "_shared-cache", "huggingface"));
    expect(env.TRANSFORMERS_CACHE).toBe(path.join(root, "_shared-cache", "huggingface", "transformers"));
    expect(env.HOME).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it("rejects symlink scope deletion and writes exact dry-run evidence without deleting", async () => {
    const root = await tempRoot();
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(root, "task-evil-codex"));
    const realScope = await createScope(root, "probe-codex-gpt-5", 25);

    const symlinkResult = await cleanupAgentEnvironmentScope({
      runtimeRoot: root,
      scopePath: path.join(root, "task-evil-codex"),
      dryRun: false,
      reason: "test",
    });
    expect(symlinkResult.deleted).toBe(false);
    expect(symlinkResult.skippedReason).toContain("not_real_directory");

    const dryRunResult = await cleanupAgentEnvironmentScope({
      runtimeRoot: root,
      scopePath: realScope,
      dryRun: true,
      reason: "probe_terminal",
    });
    expect(dryRunResult.deleted).toBe(false);
    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.path).toBe(path.resolve(realScope));
    expect(dryRunResult.bytes).toBeGreaterThanOrEqual(25);
    await expect(readFile(path.join(realScope, "home", ".npm", "payload.bin"))).resolves.toBeInstanceOf(Buffer);
  });

  it("deletes only canonical contained real directories", async () => {
    const root = await tempRoot();
    const scope = await createScope(root, "probe-codex-gpt-5", 25);

    const result = await cleanupAgentEnvironmentScope({
      runtimeRoot: root,
      scopePath: scope,
      dryRun: false,
      reason: "probe_terminal",
    });

    expect(result).toMatchObject({ deleted: true, dryRun: false, path: path.resolve(scope), reason: "probe_terminal" });
    await expect(readFile(path.join(scope, "home", ".npm", "payload.bin"))).rejects.toThrow();
  });

  it("preserves active, resumable, grace-period, and process-referenced scopes during reconciliation", async () => {
    const root = await tempRoot();
    const terminal = await createScope(root, "task-terminal-codex", 10);
    const active = await createScope(root, "task-active-codex", 10);
    const resumable = await createScope(root, "task-resumable-codex", 10);
    const young = await createScope(root, "task-young-codex", 10);
    const liveProc = await createScope(root, "task-liveproc-codex", 10);
    const now = new Date("2026-07-23T00:00:00.000Z");

    const terminalStateChecker: AgentEnvironmentTerminalStateChecker = async (scope) => {
      if (scope.scopeId === "terminal") return { terminal: true, proof: "task completed" };
      if (scope.scopeId === "active") return { terminal: false, proof: "task active" };
      if (scope.scopeId === "resumable") return { terminal: false, proof: "task blocked/resumable" };
      if (scope.scopeId === "young") return { terminal: true, proof: "task completed" };
      if (scope.scopeId === "liveproc") return { terminal: true, proof: "task completed" };
      return { terminal: false, proof: "unknown" };
    };
    const processInspector: AgentEnvironmentProcessInspector = async (scopePath) => scopePath === liveProc
      ? { referenced: true, pids: [1234] }
      : { referenced: false, pids: [] };

    const result = await reconcileAgentEnvironmentOrphans({
      runtimeRoot: root,
      dryRun: false,
      now,
      retention: { taskGraceMs: 60_000, goalGraceMs: 60_000 },
      entries: [
        { path: terminal, mtimeMs: now.getTime() - 120_000 },
        { path: active, mtimeMs: now.getTime() - 120_000 },
        { path: resumable, mtimeMs: now.getTime() - 120_000 },
        { path: young, mtimeMs: now.getTime() - 10_000 },
        { path: liveProc, mtimeMs: now.getTime() - 120_000 },
      ],
      terminalStateChecker,
      processInspector,
    });

    expect(result.deleted.map((item) => path.basename(item.path))).toEqual(["task-terminal-codex"]);
    expect(result.skipped.map((item) => path.basename(item.path))).toEqual(expect.arrayContaining([
      "task-active-codex",
      "task-resumable-codex",
      "task-young-codex",
      "task-liveproc-codex",
    ]));
    await expect(readFile(path.join(terminal, "home", ".npm", "payload.bin"))).rejects.toThrow();
    await expect(readFile(path.join(active, "home", ".npm", "payload.bin"))).resolves.toBeInstanceOf(Buffer);
  });

  it("reports readiness inventory counts, bytes, ages, reclaimable bytes, and cleanup watermark", async () => {
    const root = await tempRoot();
    const oldTask = await createScope(root, "task-done-codex", 33);
    const probe = await createScope(root, "probe-codex-model", 22);
    const activeGoal = await createScope(root, "goal-active-codex", 11);
    const now = new Date("2026-07-23T00:00:00.000Z");

    const inventory = await collectAgentEnvironmentInventory({
      runtimeRoot: root,
      now,
      entries: [
        { path: oldTask, mtimeMs: now.getTime() - 3 * 86_400_000 },
        { path: probe, mtimeMs: now.getTime() - 2 * 86_400_000 },
        { path: activeGoal, mtimeMs: now.getTime() - 86_400_000 },
      ],
      terminalStateChecker: async (scope) => ({ terminal: scope.kind !== "goal-supervisor", proof: scope.kind }),
      processInspector: async () => ({ referenced: false, pids: [] }),
      lastCleanup: { at: now.toISOString(), reclaimedBytes: 55, deletedPaths: [oldTask, probe] },
      watermark: { freeBytes: 100, totalBytes: 1_000, freeRatio: 0.1, mode: "warning" },
    });

    expect(inventory.counts).toMatchObject({ task: 1, probe: 1, goalSupervisor: 1, total: 3 });
    expect(inventory.bytes.total).toBeGreaterThanOrEqual(66);
    expect(inventory.bytes.reclaimable).toBeGreaterThanOrEqual(55);
    expect(inventory.age.oldestMs).toBe(3 * 86_400_000);
    expect(inventory.watermark?.mode).toBe("warning");
    expect(inventory.lastCleanup?.reclaimedBytes).toBe(55);
  });


  it("parses hyphenated task ids, adapters, and probe models without truncating segments", async () => {
    const root = await tempRoot();
    const taskScope = await createScope(root, "task-task-alpha-42--claude-code", 1);
    const probeScope = await createScope(root, "probe-claude-code--anthropic-claude-sonnet-4-6", 1);
    const goalScope = await createScope(root, "goal-goal-alpha-42--openclaw", 1);

    expect(parseScopePath(root, taskScope)).toMatchObject({
      kind: "task",
      scopeId: "task-alpha-42",
      adapter: "claude-code",
    });
    expect(parseScopePath(root, probeScope)).toMatchObject({
      kind: "probe",
      scopeId: "anthropic-claude-sonnet-4-6",
      adapter: "claude-code",
    });
    expect(parseScopePath(root, goalScope)).toMatchObject({
      kind: "goal-supervisor",
      scopeId: "goal-alpha-42",
      adapter: "openclaw",
    });
  });

  it("enforces shared-cache, per-scope, and global byte caps during disk-pressure checks", async () => {
    const root = await tempRoot();
    const sharedOld = await createScope(path.join(root, "_shared-cache"), "old-cache", 60);
    const oversizedProbe = await createScope(root, "probe-codex--gpt-5-5", 90);
    const oldTask = await createScope(root, "task-old-task--codex", 70);
    const activeTask = await createScope(root, "task-active-task--codex", 70);
    const staleAt = new Date("2026-07-22T00:00:00.000Z");
    await Promise.all([sharedOld, oversizedProbe, oldTask, activeTask].map((scope) => utimes(scope, staleAt, staleAt)));
    const now = new Date("2026-07-23T00:00:00.000Z");

    const result = await checkAgentEnvironmentDiskPressure({
      config: buildAgentEnvironmentLifecycleConfig({
        runtimeRoot: root,
        dryRun: false,
        warningFreeBytes: 10,
        warningFreeRatio: 0.01,
        hardFreeBytes: 1,
        hardFreeRatio: 0.001,
        perScopeByteCap: 80,
        globalByteCap: 190,
        sharedCacheByteCap: 50,
      }),
      now,
      statfs: async () => ({ freeBytes: 500, totalBytes: 1_000 }),
      terminalStateChecker: async (scope) => ({ terminal: scope.scopeId !== "active-task", proof: scope.scopeId }),
      processInspector: async () => ({ referenced: false, pids: [] }),
    });

    expect(result.allowed).toBe(true);
    expect(result.cleanup?.deleted.map((item) => path.basename(item.path))).toEqual(expect.arrayContaining([
      "old-cache",
      "probe-codex--gpt-5-5",
      "task-old-task--codex",
    ]));
    await expect(readFile(path.join(activeTask, "home", ".npm", "payload.bin"))).resolves.toBeInstanceOf(Buffer);
  });

  it("hard-stops below disk watermark, performs warning cleanup below warning watermark, and resumes after recovery", async () => {
    const root = await tempRoot();
    const oldScope = await createScope(root, "probe-codex-old", 10);
    const staleAt = new Date("2026-07-22T00:00:00.000Z");
    await utimes(oldScope, staleAt, staleAt);
    const now = new Date("2026-07-23T00:00:00.000Z");
    const config = buildAgentEnvironmentLifecycleConfig({
      runtimeRoot: root,
      dryRun: false,
      warningFreeRatio: 0.15,
      warningFreeBytes: 50,
      hardFreeRatio: 0.08,
      hardFreeBytes: 25,
    });

    const hard = await checkAgentEnvironmentDiskPressure({
      config,
      now,
      statfs: async () => ({ freeBytes: 20, totalBytes: 1_000 }),
      terminalStateChecker: async () => ({ terminal: true, proof: "probe terminal" }),
      processInspector: async () => ({ referenced: false, pids: [] }),
    });
    expect(hard.allowed).toBe(false);
    expect(hard.reason).toContain("disk_pressure_hard_stop");
    const warningScope = await createScope(root, "probe-codex-warning", 10);
    await utimes(warningScope, staleAt, staleAt);

    const warning = await checkAgentEnvironmentDiskPressure({
      config,
      now,
      statfs: async () => ({ freeBytes: 100, totalBytes: 1_000 }),
      terminalStateChecker: async () => ({ terminal: true, proof: "probe terminal" }),
      processInspector: async () => ({ referenced: false, pids: [] }),
    });
    expect(warning.allowed).toBe(true);
    expect(warning.cleanup?.deleted.length).toBeGreaterThanOrEqual(1);

    const recovered = await checkAgentEnvironmentDiskPressure({
      config,
      now,
      statfs: async () => ({ freeBytes: 500, totalBytes: 1_000 }),
    });
    expect(recovered.allowed).toBe(true);
    expect(recovered.reason).toBe("disk_pressure_recovered");
  });

  it("keeps representative 30-day load above the hard watermark by applying caps to reclaimable scopes", () => {
    const simulation = simulateAgentEnvironmentRetention({
      days: 30,
      dailyScopes: { probes: 80, tasks: 35, goalSupervisors: 4 },
      perScopeBytes: { probe: 256 * 1024 * 1024, task: 768 * 1024 * 1024, goalSupervisor: 1024 * 1024 * 1024 },
      sharedCacheBytes: 8 * 1024 * 1024 * 1024,
      diskTotalBytes: 1_000 * 1024 * 1024 * 1024,
      hardFreeBytes: 25 * 1024 * 1024 * 1024,
      hardFreeRatio: 0.08,
      retention: { taskGraceDays: 2, goalGraceDays: 7, probeGraceDays: 0 },
      globalByteCap: 160 * 1024 * 1024 * 1024,
      perScopeByteCap: 2 * 1024 * 1024 * 1024,
    });

    expect(simulation.minimumFreeBytes).toBeGreaterThanOrEqual(simulation.hardWatermarkBytes);
    expect(simulation.finalAgentEnvironmentBytes).toBeLessThanOrEqual(160 * 1024 * 1024 * 1024);
  });
});
