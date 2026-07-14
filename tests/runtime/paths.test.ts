import { describe, expect, it } from "vitest";
import {
  HIVEWRIGHT_ENV_FILE_ENV,
  HIVEWRIGHT_RUNTIME_ROOT_ENV,
  assertOutsideRepo,
  resolveDefaultRuntimeHome,
  resolveHivewrightEnvFilePath,
  resolveHivewrightRuntimeRoot,
  resolveRuntimePath,
} from "@/runtime/paths";

describe("HiveWright runtime paths", () => {
  it("defaults runtime state outside the software repo", () => {
    const repoRoot = "/opt/hivewright/app";
    const env: Record<string, string | undefined> = {};
    const options = {
      osHomeDir: "/home/tester",
      userHomeDir: "/home/tester",
      runtimeRootExists: () => false,
    };

    expect(resolveHivewrightRuntimeRoot(env, repoRoot, options)).toBe("/home/tester/.hivewright");
    expect(resolveRuntimePath(["hives"], env, repoRoot, options)).toBe("/home/tester/.hivewright/hives");
    expect(resolveHivewrightEnvFilePath(env, repoRoot, options)).toBe("/home/tester/.hivewright/config/.env");
  });

  it("allows explicit external runtime and env paths", () => {
    const repoRoot = "/opt/hivewright/app";
    const env = {
      [HIVEWRIGHT_RUNTIME_ROOT_ENV]: "/srv/hivewright/runtime",
      [HIVEWRIGHT_ENV_FILE_ENV]: "/etc/hivewright/hivewright.env",
    };

    expect(resolveHivewrightRuntimeRoot(env, repoRoot)).toBe("/srv/hivewright/runtime");
    expect(resolveHivewrightEnvFilePath(env, repoRoot)).toBe("/etc/hivewright/hivewright.env");
  });

  it("rejects runtime paths inside the software repo", () => {
    const repoRoot = "/opt/hivewright/app";

    expect(() => assertOutsideRepo("/opt/hivewright/app/runtime", repoRoot)).toThrow(/outside the HiveWright software repository/);
    expect(() => resolveHivewrightRuntimeRoot({ [HIVEWRIGHT_RUNTIME_ROOT_ENV]: "/opt/hivewright/app/.runtime" }, repoRoot)).toThrow(/outside the HiveWright software repository/);
    expect(() => resolveHivewrightEnvFilePath({ [HIVEWRIGHT_ENV_FILE_ENV]: "/opt/hivewright/app/.env" }, repoRoot)).toThrow(/outside the HiveWright software repository/);
  });

  it("prefers the real user home when task-scoped HOME has no runtime root", () => {
    const env = {
      HOME: "/tmp/hivewright-agent-home",
    };

    expect(resolveDefaultRuntimeHome(env, {
      userHomeDir: "/home/tester",
      osHomeDir: "/tmp/hivewright-agent-home",
      runtimeRootExists: (candidate) => candidate === "/home/tester/.hivewright",
    })).toBe("/home/tester");
    expect(resolveHivewrightRuntimeRoot(env, "/opt/hivewright/app", {
      userHomeDir: "/home/tester",
      osHomeDir: "/tmp/hivewright-agent-home",
      runtimeRootExists: (candidate) => candidate === "/home/tester/.hivewright",
    })).toBe("/home/tester/.hivewright");
  });
});
