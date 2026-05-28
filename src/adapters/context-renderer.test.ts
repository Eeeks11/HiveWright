import { describe, expect, it } from "vitest";
import { renderSessionPrompt } from "./context-renderer";
import type { SessionContext } from "./types";

function buildContext(): SessionContext {
  return {
    task: {
      id: "task-1",
      hiveId: "hive-1",
      title: "Ship memory governance",
      brief: "Implement the bounded slice.",
      acceptanceCriteria: null,
      assignedTo: "developer-agent",
      goalId: null,
      projectId: null,
      parentTaskId: null,
      retryCount: 0,
      createdBy: "owner",
    } as SessionContext["task"],
    roleTemplate: {
      slug: "developer-agent",
      department: "engineering",
      roleMd: null,
      soulMd: null,
      toolsMd: null,
      source: { type: "system-library" },
    },
    memoryContext: {
      roleMemory: [],
      hiveMemory: [],
      insights: [],
      capacity: "memory disabled",
      governance: {
        memoryEnabled: false,
        statusLabel: "Status: disabled; same-hive memory reuse is blocked for this hive.",
        scopeLabel: "Scope: agent/session memory injection is disabled until the hive memory control is re-enabled.",
        blockedReason: "Owner paused memory",
      },
    },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: "/tmp/hive",
    credentials: {},
    model: "gpt-5",
    fallbackModel: null,
  };
}

describe("renderSessionPrompt", () => {
  it("renders memory governance labels inside the prompt context", () => {
    const prompt = renderSessionPrompt(buildContext());

    expect(prompt).toContain("Status: disabled; same-hive memory reuse is blocked for this hive.");
    expect(prompt).toContain("Scope: agent/session memory injection is disabled until the hive memory control is re-enabled.");
  });
});
