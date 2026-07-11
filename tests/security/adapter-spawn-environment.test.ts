import { EventEmitter } from "events";
import { mkdtemp, rm } from "fs/promises";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/adapters/types";
import type { ClaimedTask } from "@/dispatcher/types";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));
vi.mock("@/audit/agent-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/audit/agent-events")>()),
  recordAgentAuditEventBestEffort: vi.fn(),
}));

import { CodexAdapter } from "@/adapters/codex";
import { ClaudeCodeAdapter } from "@/adapters/claude-code";
import { GeminiAdapter } from "@/adapters/gemini";
import { OpenClawAdapter } from "@/adapters/openclaw";

const SENTINELS = {
  DATABASE_URL: "sentinel-database",
  ENCRYPTION_KEY: "sentinel-encryption",
  INTERNAL_SERVICE_TOKEN: "sentinel-internal-service",
  AUTH_SECRET: "sentinel-dashboard",
  SESSION_SECRET: "sentinel-session",
  DEPLOY_TOKEN: "sentinel-deployment",
  OPENAI_API_KEY: "sentinel-unrelated-provider",
  SLACK_BOT_TOKEN: "sentinel-unrelated-connector",
};

type FakeProc = EventEmitter & {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
};

const previousEnv: Record<string, string | undefined> = {};
let workspace = "";

beforeEach(async () => {
  mockSpawn.mockReset();
  workspace = await mkdtemp(path.join(process.cwd(), ".hw-adapter-env-"));
  for (const [key, value] of Object.entries(SENTINELS)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  mockSpawn.mockImplementation((_command: string, args: string[]) => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn(() => true);
    proc.exitCode = null;
    queueMicrotask(() => {
      const command = args.includes("--output-format") && args.includes("stream-json")
        ? JSON.stringify({ type: "result", status: "success", stats: {} })
        : args.includes("--output-format")
          ? JSON.stringify({ type: "result", result: "ok" })
          : args.includes("--json")
            ? [
                JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
                JSON.stringify({ type: "turn.completed", usage: {} }),
              ].join("\n")
            : "session-id";
      proc.stdout.emit("data", Buffer.from(command));
      proc.exitCode = 0;
      proc.emit("close", 0);
    });
    return proc;
  });
});

afterEach(async () => {
  for (const key of Object.keys(SENTINELS)) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(workspace, { recursive: true, force: true });
  await rm(path.join(process.cwd(), ".hivewright-agent-runtime"), { recursive: true, force: true });
});

describe("adapter child-process environment boundary", () => {
  it("denies ambient sentinels on every probe, execute, resume, and OpenClaw session path", async () => {
    const codexCtx = context("openai-codex/gpt-5.5", { CODEX_SCOPED_TOKEN: "codex-scoped" });
    const claudeCtx = context("anthropic/claude-sonnet-4-6", { ANTHROPIC_API_KEY: "claude-scoped" });
    const geminiCtx = context("google/gemini-2.5-flash", { GEMINI_API_KEY: "gemini-scoped" });
    const openclawCtx = context("anthropic/claude-sonnet-4-6", { GITHUB_TOKEN: "github-scoped" });

    const codex = new CodexAdapter();
    await codex.probe(codexCtx.model, { provider: "openai-codex", secrets: { CODEX_SCOPED_TOKEN: "codex-probe" } });
    await codex.execute(codexCtx);
    await codex.sendMessage("codex-session", "resume", codexCtx);

    const claude = new ClaudeCodeAdapter();
    await claude.probe(claudeCtx.model, { provider: "anthropic", secrets: { ANTHROPIC_API_KEY: "claude-probe" } });
    await claude.execute(claudeCtx);

    const gemini = new GeminiAdapter();
    await gemini.probe(geminiCtx.model, { provider: "google", secrets: { GEMINI_API_KEY: "gemini-probe" } });
    await gemini.execute(geminiCtx);

    const openclaw = new OpenClawAdapter();
    await openclaw.execute(openclawCtx);
    const { sessionId } = await openclaw.startSession(openclawCtx);
    await openclaw.sendMessage(sessionId, "resume", openclawCtx);
    await openclaw.terminateSession(sessionId);

    expect(mockSpawn).toHaveBeenCalledTimes(11);
    const spawnEnvironments = mockSpawn.mock.calls.map((call) => call[2]?.env as NodeJS.ProcessEnv);
    for (const env of spawnEnvironments) {
      for (const [key, sentinel] of Object.entries(SENTINELS)) {
        expect(env[key], `${String(mockSpawn.mock.calls[spawnEnvironments.indexOf(env)]?.[0])}:${key}`).not.toBe(sentinel);
      }
      expect(env.HOME).toContain(".hivewright-agent-runtime");
      expect(env.TMPDIR).toContain(".hivewright-agent-runtime");
    }

    expect(spawnEnvironments.some((env) => env.CODEX_SCOPED_TOKEN === "codex-scoped")).toBe(true);
    expect(spawnEnvironments.some((env) => env.ANTHROPIC_API_KEY === "claude-scoped")).toBe(true);
    expect(spawnEnvironments.some((env) => env.GEMINI_API_KEY === "gemini-scoped")).toBe(true);
    expect(spawnEnvironments.some((env) => env.GITHUB_TOKEN === "github-scoped")).toBe(true);

    const taskEnvironments = spawnEnvironments.filter((env) => env.HIVEWRIGHT_TASK_ID !== undefined);
    expect(taskEnvironments).toHaveLength(7);
    expect(taskEnvironments.every((env) => env.HIVEWRIGHT_TASK_ID === "task-security" && env.HIVEWRIGHT_HIVE_ID === "hive-security")).toBe(true);
  });
});

function context(model: string, credentials: Record<string, string>): SessionContext {
  return {
    task: {
      id: "task-security",
      hiveId: "hive-security",
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 1,
      title: "Security boundary",
      brief: "Exercise child process environment.",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "No sentinel leaks",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    } as ClaimedTask,
    roleTemplate: {
      slug: "dev-agent",
      department: "engineering",
      roleMd: "# Developer",
      soulMd: null,
      toolsMd: null,
    },
    memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "0/200" },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: workspace,
    model,
    fallbackModel: null,
    credentials,
  };
}
