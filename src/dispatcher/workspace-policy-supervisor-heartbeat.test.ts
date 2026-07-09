import { describe, expect, it } from "vitest";
import type { SessionContext } from "../adapters/types";
import type { ClaimedTask } from "./types";
import { evaluateTaskWorkspacePolicy, isCodeChangingTask } from "./workspace-policy";

const baseTask: ClaimedTask = {
  id: "task-1",
  hiveId: "hive-1",
  assignedTo: "dev-agent",
  createdBy: "goal-supervisor",
  status: "active",
  priority: 10,
  title: "Fix HiveWright dashboard task stream",
  brief: "Patch the HiveWright dashboard code and add tests.",
  parentTaskId: null,
  goalId: null,
  sprintNumber: null,
  qaRequired: false,
  acceptanceCriteria: "Vitest covers the task stream fix.",
  retryCount: 0,
  doctorAttempts: 0,
  failureReason: null,
  adapterOverride: null,
  modelOverride: null,
  projectId: null,
};

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  const task = overrides.task ?? baseTask;
  return {
    task,
    roleTemplate: { slug: task.assignedTo, department: "engineering", roleMd: null, soulMd: null, toolsMd: null },
    memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "none" },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: "/home/trent/businesses/example",
    gitBackedProject: false,
    baseProjectWorkspace: "/home/trent/businesses/example",
    workspaceIsolation: null,
    model: "openai-codex/gpt-5.5",
    fallbackModel: null,
    credentials: {},
    ...overrides,
  };
}

describe("supervisor heartbeat workspace policy classification", () => {
  it("does not classify supervisor heartbeat reports as code-changing just because they cite runtime/source evidence", () => {
    const task = {
      ...baseTask,
      assignedTo: "hive-supervisor",
      title: "Hive supervisor heartbeat - 62 finding(s)",
      brief: [
        "## Hive Health Report",
        "Primary publication source: authenticated /api/analyst-telemetry?hiveId=...",
        "Latest task evidence mentions dashboard/API route status, runtime build hash, source logs, and previous workspace_policy_blocked text.",
        "End your reply with a fenced json SupervisorActions object using findings_addressed to reference finding ids.",
        "If a true code defect remains, hand it off separately as one bounded implementation follow-up with evidence.",
      ].join("\n"),
      acceptanceCriteria:
        "Administrative health/report/routing packet only; choose create_decision/noop/spawn_followup disposition without local app-source discovery.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      hiveSlug: "hivewright",
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      gitBackedProject: false,
    }))).toMatchObject({
      allowed: true,
      signals: expect.arrayContaining(["non_code_changing_task"]),
    });
  });

  it("does not let quoted implementation finding summaries veto heartbeat reports", () => {
    const task = {
      ...baseTask,
      assignedTo: "hive-supervisor",
      title: "Hive supervisor heartbeat - 1 finding(s)",
      brief: [
        "## Hive Health Report",
        "Primary publication source: authenticated /api/analyst-telemetry?hiveId=...",
        "## Findings",
        "- F-1: stalled implementation task titled \"Patch the HiveWright dashboard source code and add Vitest tests\" remains blocked by workspace policy.",
        "Supervisor actions should use findings_addressed to reference finding ids and spawn a separate bounded follow-up if needed.",
      ].join("\n"),
      acceptanceCriteria:
        "Administrative health/report/routing packet only; do not perform source edits in this heartbeat.",
    };

    expect(isCodeChangingTask(task)).toBe(false);
    expect(evaluateTaskWorkspacePolicy(ctx({
      task,
      hiveSlug: "hivewright",
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      gitBackedProject: false,
    }))).toMatchObject({
      allowed: true,
      signals: expect.arrayContaining(["non_code_changing_task"]),
    });
  });

  it("still blocks direct hive-supervisor source-edit requests without approved git-backed project routing", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "hive-supervisor",
        title: "Hive supervisor heartbeat: patch HiveWright dispatcher source code",
        brief: "Patch the HiveWright dispatcher source code in this task and add a Vitest regression test.",
        acceptanceCriteria: "Code changes and tests are committed.",
      },
      hiveSlug: "hivewright",
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      gitBackedProject: false,
      workspaceIsolation: null,
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("no approved git-backed project_id");
      expect(decision.signals).toContain("code_changing_task");
    }
  });

  it("still blocks genuine HiveWright source edits without approved git-backed project routing", () => {
    const decision = evaluateTaskWorkspacePolicy(ctx({
      task: {
        ...baseTask,
        assignedTo: "dev-agent",
        title: "Fix HiveWright dispatcher heartbeat classification bug",
        brief: "Patch the HiveWright dispatcher source code and add a Vitest regression test.",
        acceptanceCriteria: "Code changes and tests are committed.",
      },
      hiveSlug: "hivewright",
      projectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      baseProjectWorkspace: "/home/trent/.hivewright/hives/hivewright/projects/runtime-health",
      gitBackedProject: false,
      workspaceIsolation: null,
    }));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("no approved git-backed project_id");
      expect(decision.signals).toContain("code_changing_task");
    }
  });
});
