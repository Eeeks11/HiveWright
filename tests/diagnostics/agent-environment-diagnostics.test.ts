import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectAgentEnvironmentDiagnostics,
  setLastAgentEnvironmentCleanupResultForTests,
} from "@/diagnostics/checks";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = path.join(tmpdir(), `hw-agent-env-diagnostics-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  setLastAgentEnvironmentCleanupResultForTests(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("collectAgentEnvironmentDiagnostics", () => {
  it("reports inventory counts, reclaimable bytes, watermarks, and last cleanup evidence", async () => {
    const root = await tempRoot();
    const oldTask = await createScope(root, "task-done-task--codex", 33);
    const probe = await createScope(root, "probe-codex--gpt-5-5", 22);
    const activeGoal = await createScope(root, "goal-active-goal--openclaw", 11);
    const now = new Date("2026-07-23T00:00:00.000Z");

    setLastAgentEnvironmentCleanupResultForTests({
      at: now.toISOString(),
      reclaimedBytes: 55,
      deletedPaths: [oldTask, probe],
      reason: "warning_cleanup",
    });

    const diagnostics = await collectAgentEnvironmentDiagnostics({
      runtimeRoot: root,
      now,
      entries: [
        { path: oldTask, mtimeMs: now.getTime() - 3 * 86_400_000 },
        { path: probe, mtimeMs: now.getTime() - 2 * 86_400_000 },
        { path: activeGoal, mtimeMs: now.getTime() - 86_400_000 },
      ],
      terminalStateChecker: async (scope) => ({ terminal: scope.kind !== "goal-supervisor", proof: scope.kind }),
      processInspector: async () => ({ referenced: false, pids: [] }),
      statfs: async () => ({ freeBytes: 100, totalBytes: 1_000 }),
    });

    expect(diagnostics.runtimeRoot).toBe(root);
    expect(diagnostics.counts).toMatchObject({ task: 1, probe: 1, goalSupervisor: 1, total: 3 });
    expect(diagnostics.bytes.total).toBeGreaterThanOrEqual(66);
    expect(diagnostics.bytes.reclaimable).toBeGreaterThanOrEqual(55);
    expect(diagnostics.age.oldestMs).toBe(3 * 86_400_000);
    expect(diagnostics.watermark).toEqual({ freeBytes: 100, totalBytes: 1_000, freeRatio: 0.1, mode: "hard" });
    expect(diagnostics.lastCleanup).toEqual({
      at: now.toISOString(),
      reclaimedBytes: 55,
      deletedPaths: [oldTask, probe],
      reason: "warning_cleanup",
    });
  });
});
