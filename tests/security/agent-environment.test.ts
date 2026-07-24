import { mkdtemp, readlink, rm, symlink } from "fs/promises";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentEnvironment } from "@/security/agent-environment";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ambientSentinels = {
  DATABASE_URL: "sentinel-database",
  ENCRYPTION_KEY: "sentinel-encryption",
  INTERNAL_SERVICE_TOKEN: "sentinel-internal-service",
  AUTH_SECRET: "sentinel-dashboard-auth",
  SESSION_SECRET: "sentinel-session",
  DEPLOY_TOKEN: "sentinel-deployment",
  OPENAI_API_KEY: "sentinel-unrelated-provider",
  GITHUB_TOKEN: "sentinel-unrelated-connector",
  TOTALLY_UNKNOWN_VALUE: "sentinel-unknown",
};

describe("buildAgentEnvironment", () => {
  it("starts empty, copies only runtime basics, and adds only explicitly scoped credentials", async () => {
    const runtimeRoot = await mkdtemp(path.join(process.cwd(), ".hw-agent-env-test-"));
    roots.push(runtimeRoot);

    const env = buildAgentEnvironment({
      ambientEnv: {
        ...ambientSentinels,
        PATH: "/runtime/bin",
        LANG: "en_AU.UTF-8",
        LC_ALL: "C.UTF-8",
        TERM: "xterm-256color",
      },
      runtimeRoot,
      scope: { kind: "task", adapter: "claude-code", taskId: "task/one", hiveId: "hive-one" },
      credentials: {
        ANTHROPIC_API_KEY: "scoped-anthropic",
        INTERNAL_SERVICE_TOKEN: "scoped-internal-service",
      },
    });

    expect(env).toMatchObject({
      PATH: "/runtime/bin",
      LANG: "en_AU.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "xterm-256color",
      HIVEWRIGHT_TASK_ID: "task/one",
      HIVEWRIGHT_HIVE_ID: "hive-one",
      ANTHROPIC_API_KEY: "scoped-anthropic",
      INTERNAL_SERVICE_TOKEN: "scoped-internal-service",
    });
    for (const [key, sentinel] of Object.entries(ambientSentinels)) {
      expect(env[key], key).not.toBe(sentinel);
    }
    expect(env.HOME).toContain("task-task-one");
    expect(env.TMPDIR).toContain("task-task-one");
    expect(env.XDG_CONFIG_HOME).toBe(path.join(env.HOME!, ".config"));
    expect(env.XDG_CACHE_HOME).toBe(path.join(env.HOME!, ".cache"));
    expect(env.XDG_DATA_HOME).toBe(path.join(env.HOME!, ".local", "share"));
  });

  it("does not let credentials replace boundary-owned paths or scope identifiers", async () => {
    const runtimeRoot = await mkdtemp(path.join(process.cwd(), ".hw-agent-env-test-"));
    roots.push(runtimeRoot);

    const env = buildAgentEnvironment({
      ambientEnv: { PATH: "/bin" },
      runtimeRoot,
      scope: { kind: "task", adapter: "codex", taskId: "real-task", hiveId: "real-hive" },
      credentials: {
        HOME: "/attacker/home",
        TMPDIR: "/attacker/tmp",
        PATH: "/attacker/bin",
        HIVEWRIGHT_TASK_ID: "wrong-task",
        HIVEWRIGHT_HIVE_ID: "wrong-hive",
      },
    });

    expect(env.PATH).toBe("/bin");
    expect(env.HOME).not.toBe("/attacker/home");
    expect(env.TMPDIR).not.toBe("/attacker/tmp");
    expect(env.HIVEWRIGHT_TASK_ID).toBe("real-task");
    expect(env.HIVEWRIGHT_HIVE_ID).toBe("real-hive");
  });

  it("uses stable probe and goal homes and links only the requested native provider state", async () => {
    const runtimeRoot = await mkdtemp(path.join(process.cwd(), ".hw-agent-env-test-"));
    roots.push(runtimeRoot);
    const nativeHome = path.join(runtimeRoot, "native");

    const env = buildAgentEnvironment({
      ambientEnv: { PATH: "/bin", HOME: nativeHome },
      runtimeRoot,
      scope: {
        kind: "goal-supervisor",
        adapter: "codex",
        goalId: "goal-1",
        hiveId: "hive-1",
        supervisorSession: "/runtime/goals/goal-1",
      },
      nativeProviderState: [".codex"],
    });

    expect(env.HIVEWRIGHT_GOAL_ID).toBe("goal-1");
    expect(env.HIVEWRIGHT_HIVE_ID).toBe("hive-1");
    expect(env.HIVEWRIGHT_TASK_ID).toBeUndefined();
    expect(env.HIVEWRIGHT_SUPERVISOR_SESSION).toBe("/runtime/goals/goal-1");
    expect(await readlink(path.join(env.HOME!, ".codex"))).toBe(path.join(nativeHome, ".codex"));
  });

  it("refuses a pre-planted symlink in the task runtime path", async () => {
    const runtimeRoot = await mkdtemp(path.join(process.cwd(), ".hw-agent-env-test-"));
    roots.push(runtimeRoot);
    const outside = path.join(runtimeRoot, "outside");
    const scopeRoot = path.join(runtimeRoot, "task-task-one--codex");
    await symlink(outside, scopeRoot);

    expect(() => buildAgentEnvironment({
      runtimeRoot,
      scope: { kind: "task", adapter: "codex", taskId: "task-one", hiveId: "hive-one" },
    })).toThrow("Agent runtime path must be a real directory");
  });
});
