import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRuntimePathProof, findProjectRoot, resolveRuntimePathProofOutputPath } from "@/readiness/runtime-path-proof";

describe("runtime path proof", () => {
  it("passes when runtime, env file, and hive workspaces resolve outside repo", () => {
    const repoRoot = "/workspace/hivewrightv2";
    const proof = buildRuntimePathProof({
      HIVEWRIGHT_RUNTIME_ROOT: "/var/lib/hivewright",
      HIVEWRIGHT_ENV_FILE: "/var/lib/hivewright/config/.env",
      HIVES_WORKSPACE_ROOT: "/var/lib/hivewright/hives",
    }, repoRoot);
    expect(proof.status).toBe("pass");
    expect(proof.entries.filter((entry) => entry.label !== "repoRoot").every((entry) => entry.outsideRepo)).toBe(true);
  });

  it("fails closed when a configured runtime path points into the repo", () => {
    const repoRoot = "/workspace/hivewrightv2";
    const proof = buildRuntimePathProof({
      HIVEWRIGHT_RUNTIME_ROOT: path.join(repoRoot, "runtime"),
    }, repoRoot);
    expect(proof.status).toBe("fail");
    expect(proof.failures.join("\n")).toContain("outside the HiveWright software repository");
  });

  it("finds the project root from a subdirectory instead of trusting cwd", () => {
    const repoRoot = findProjectRoot(path.join(process.cwd(), "src", "readiness"));
    expect(repoRoot).toBe(process.cwd());
  });

  it("writes the runtime path proof under the external runtime root", () => {
    const repoRoot = "/home/operator/apps/HiveWright";
    const outputPath = resolveRuntimePathProofOutputPath(
      { HIVEWRIGHT_RUNTIME_ROOT: "/home/operator/.hivewright" },
      repoRoot,
    );

    expect(outputPath).toBe("/home/operator/.hivewright/tmp/readiness/runtime-path-proof.md");
  });

  it("rejects runtime path proof output paths inside the repository", () => {
    const repoRoot = "/home/operator/apps/HiveWright";
    expect(() =>
      resolveRuntimePathProofOutputPath({ HIVEWRIGHT_RUNTIME_ROOT: path.join(repoRoot, ".hivewright") }, repoRoot),
    ).toThrow(/outside the HiveWright software repository/);
  });
});
