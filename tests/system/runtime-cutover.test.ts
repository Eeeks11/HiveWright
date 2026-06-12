import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateRuntimeCutover,
  readRuntimeCutoverRecord,
  resolveRuntimeCutoverPath,
} from "@/system/runtime-cutover";

const tmpRoots: string[] = [];

describe("runtime cutover record", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("resolves the canonical cutover path under the runtime root", () => {
    expect(resolveRuntimeCutoverPath({ HIVEWRIGHT_RUNTIME_ROOT: "/srv/hivewright/runtime" }, "/repo")).toBe(
      "/srv/hivewright/runtime/logs/deployments/latest-runtime-cutover.json",
    );
  });

  it("reports unavailable when the cutover record has not been written yet", async () => {
    const repoRoot = await makeRepoRoot();
    const runtimeRoot = path.join(os.tmpdir(), "runtime-cutover-missing");

    const read = await readRuntimeCutoverRecord({
      env: { HIVEWRIGHT_RUNTIME_ROOT: runtimeRoot },
      repoRoot,
    });
    const status = evaluateRuntimeCutover({ ...read });

    expect(status).toMatchObject({
      available: false,
      state: "unavailable",
      record: null,
    });
    expect(status.reasons[0]).toContain("has not been written yet");
  });

  it("treats a canonical record as in sync when the recorded install matches live expectations", async () => {
    const repoRoot = await makeRepoRoot();
    const runtimeRoot = await makeRuntimeRoot();
    const cutoverPath = path.join(runtimeRoot, "logs", "deployments", "latest-runtime-cutover.json");
    await fs.mkdir(path.dirname(cutoverPath), { recursive: true });
    await fs.writeFile(cutoverPath, JSON.stringify({
      recordedAt: "2026-06-13T00:33:00.000Z",
      runtimeMode: "locked-install",
      installDir: "/home/trent/apps/HiveWright",
      runtimeRoot,
      envFile: `${runtimeRoot}/config/.env`,
      dashboardHealthUrl: "http://localhost:3002",
      deployedCommit: "18cacfaa6b8682bde5802e7b2b53f63470f63d3e",
      buildHash: "18cacfaa6b8682bde5802e7b2b53f63470f63d3e",
      dashboard: { pid: 101, cwd: "/home/trent/apps/HiveWright" },
      dispatcher: { pid: 202, cwd: "/home/trent/apps/HiveWright" },
    }));

    const read = await readRuntimeCutoverRecord({
      env: { HIVEWRIGHT_RUNTIME_ROOT: runtimeRoot },
      repoRoot,
    });
    const status = evaluateRuntimeCutover({
      ...read,
      expected: {
        runtimeMode: "locked-install",
        installDir: "/home/trent/apps/HiveWright",
        runtimeRoot,
        envFile: `${runtimeRoot}/config/.env`,
        dashboardHealthUrl: "http://localhost:3002",
        currentCommit: "18cacfaa6b8682bde5802e7b2b53f63470f63d3e",
        currentBuildHash: "18cacfaa6b8682bde5802e7b2b53f63470f63d3e",
      },
    });

    expect(status).toMatchObject({
      available: true,
      state: "in_sync",
    });
    expect(status.reasons).toEqual([]);
  });

  it("flags legacy or stale records as drift when runtime mode or commit provenance no longer matches", async () => {
    const repoRoot = await makeRepoRoot();
    const runtimeRoot = await makeRuntimeRoot();
    const cutoverPath = path.join(runtimeRoot, "logs", "deployments", "latest-runtime-cutover.json");
    await fs.mkdir(path.dirname(cutoverPath), { recursive: true });
    await fs.writeFile(cutoverPath, JSON.stringify({
      completedAt: "2026-06-11T00:00:00.000Z",
      runtimeCheckout: "/home/trent/dev/hivewright-live",
      runtimeRoot,
      deployedCommit: "ba33cbdcecb6f30ed8c8daa7d80f19e7049f4e44",
      buildHash: "ba33cbdcecb6f30ed8c8daa7d80f19e7049f4e44",
      dashboard: { pid: 101, cwd: "/home/trent/dev/hivewright-live" },
      dispatcher: { pid: 202, cwd: "/home/trent/dev/hivewright-live" },
    }));

    const read = await readRuntimeCutoverRecord({
      env: { HIVEWRIGHT_RUNTIME_ROOT: runtimeRoot },
      repoRoot,
    });
    const status = evaluateRuntimeCutover({
      ...read,
      expected: {
        runtimeMode: "locked-install",
        installDir: "/home/trent/apps/HiveWright",
        runtimeRoot,
        currentCommit: "18cacfaa6b8682bde5802e7b2b53f63470f63d3e",
        currentBuildHash: "18cacfaa6b8682bde5802e7b2b53f63470f63d3e",
      },
    });

    expect(status.available).toBe(true);
    expect(status.state).toBe("drift");
    expect(status.reasons.join("\n")).toContain("runtimeMode");
    expect(status.reasons.join("\n")).toContain("/home/trent/apps/HiveWright");
    expect(status.reasons.join("\n")).toContain("18cacfaa6b8682bde5802e7b2b53f63470f63d3e");
  });
});

async function makeRepoRoot() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-cutover-repo-"));
  tmpRoots.push(repoRoot);
  await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ name: "test-repo" }));
  return repoRoot;
}

async function makeRuntimeRoot() {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-cutover-runtime-"));
  tmpRoots.push(runtimeRoot);
  return runtimeRoot;
}
