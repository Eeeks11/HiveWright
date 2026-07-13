import { describe, it, expect } from "vitest";

// Pure-function tests for the codex supervisor backend. The startGoalSupervisor /
// wakeUpSupervisor entry points spawn a real codex CLI subprocess so we don't
// exercise them in unit tests — that path is verified live via dispatcher logs.
//
// Here we focus on the selector behaviour, argument construction, and JSONL
// success parsing used by both sprint and owner-comment wakes.

describe("supervisor-codex extractThreadId behaviour (via JSONL parsing)", () => {
  it("pulls thread_id from a thread.started event", async () => {
    const { extractThreadId } = await import("@/goals/supervisor-codex");
    const stdout = [
      '{"type":"thread.started","thread_id":"abc-123-uuid"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(extractThreadId(stdout)).toBe("abc-123-uuid");
  });

  it("returns null when no thread.started event is present", async () => {
    const { extractThreadId } = await import("@/goals/supervisor-codex");
    const stdout = '{"type":"turn.completed"}';
    expect(extractThreadId(stdout)).toBeNull();
  });

  it("ignores malformed JSONL lines instead of throwing", async () => {
    const { extractThreadId } = await import("@/goals/supervisor-codex");
    const stdout = 'garbage line\n{not valid json\n{"type":"thread.started","thread_id":"good-uuid"}';
    expect(extractThreadId(stdout)).toBe("good-uuid");
  });
});

describe("supervisor-codex wake argument construction", () => {
  const workspacePath = "/tmp/hw-goal-workspace";
  const modelName = "gpt-5.5-codex";

  it.each(["sprint", "comment"] as const)(
    "uses the shared safe resume flags without -m for %s wakes",
    async (wakeKind) => {
      const { buildCodexWakeArgs } = await import("@/goals/supervisor-codex");

      const args = buildCodexWakeArgs({
        threadId: "thread-123",
        modelName,
        workspacePath,
        wakeKind,
      });

      expect(args).toEqual([
        "exec",
        "resume",
        "thread-123",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-",
      ]);
      expect(args).not.toContain("-m");
      expect(args).not.toContain(modelName);
      expect(args).not.toContain("-C");
      expect(args).not.toContain(workspacePath);
    },
  );

  it.each(["sprint", "comment"] as const)(
    "preserves the model and workspace flags for fresh %s wakes",
    async (wakeKind) => {
      const { buildCodexWakeArgs } = await import("@/goals/supervisor-codex");

      expect(buildCodexWakeArgs({
        threadId: null,
        modelName,
        workspacePath,
        wakeKind,
      })).toEqual([
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-m",
        modelName,
        "-C",
        workspacePath,
      ]);
    },
  );
});

describe("supervisor-codex terminal agent-message validation", () => {
  it("accepts stdout with a terminal agent_message item", async () => {
    const { hasTerminalAgentMessage } = await import("@/goals/supervisor-codex");

    expect(hasTerminalAgentMessage([
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"I made progress."}}',
      '{"type":"turn.completed"}',
    ].join("\n"))).toBe(true);
  });

  it("accepts stdout with a non-empty turn.completed last_agent_message", async () => {
    const { hasTerminalAgentMessage } = await import("@/goals/supervisor-codex");

    expect(hasTerminalAgentMessage(
      '{"type":"turn.completed","last_agent_message":"I made progress."}',
    )).toBe(true);
  });

  it.each(["sprint", "comment"] as const)(
    "treats exit 0 without a terminal agent message as failed for %s wakes",
    async (wakeKind) => {
      const { validateCodexWakeResult } = await import("@/goals/supervisor-codex");

      const result = validateCodexWakeResult({
        wakeKind,
        runResult: {
          code: 0,
          stdout: '{"type":"turn.completed","last_agent_message":null}',
          stderr: "",
        },
      });

      expect(result.success).toBe(false);
      expect(result.output).toBe('{"type":"turn.completed","last_agent_message":null}');
      expect(result.error).toContain("terminal agent message");
    },
  );
});
