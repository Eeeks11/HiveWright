import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertHiveMemoryWriteAllowed: vi.fn(),
  markMemoryWritten: vi.fn(),
  recordAgentAuditEventBestEffort: vi.fn(),
  sendNotification: vi.fn(),
  pruneGoalSupervisor: vi.fn(),
  verifyLandedState: vi.fn(),
  createLearningGateFollowup: vi.fn(),
  normalizeFinalArtifactsFromEvidenceBundle: vi.fn(),
  assertRequiredFinalArtifactsAvailable: vi.fn(),
  upsertOwnerOutcomeForCompletion: vi.fn(),
}));

vi.mock("@/memory/governance", () => ({
  assertHiveMemoryWriteAllowed: mocks.assertHiveMemoryWriteAllowed,
  markMemoryWritten: mocks.markMemoryWritten,
}));

vi.mock("../audit/agent-events", () => ({
  AGENT_AUDIT_EVENTS: {
    hiveMemoryWritten: "hive_memory.written",
  },
  recordAgentAuditEventBestEffort: mocks.recordAgentAuditEventBestEffort,
}));

vi.mock("../notifications/sender", () => ({
  sendNotification: mocks.sendNotification,
}));

vi.mock("../openclaw/goal-supervisor-cleanup", () => ({
  pruneGoalSupervisor: mocks.pruneGoalSupervisor,
}));

vi.mock("../software-pipeline/landed-state-gate", () => ({
  verifyLandedState: mocks.verifyLandedState,
}));

vi.mock("./learning-gate-followup", () => ({
  createLearningGateFollowup: mocks.createLearningGateFollowup,
}));

vi.mock("./final-artifacts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./final-artifacts")>(),
  normalizeFinalArtifactsFromEvidenceBundle: mocks.normalizeFinalArtifactsFromEvidenceBundle,
  assertRequiredFinalArtifactsAvailable: mocks.assertRequiredFinalArtifactsAvailable,
}));

vi.mock("@/outcomes/durable", () => ({
  upsertOwnerOutcomeForCompletion: mocks.upsertOwnerOutcomeForCompletion,
}));

import { completeGoal } from "./completion";

describe("completeGoal memory governance", () => {
  const tx = vi.fn() as ReturnType<typeof vi.fn> & { json: ReturnType<typeof vi.fn> };
  const sql = vi.fn() as ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    tx
      .mockResolvedValueOnce([{ hive_id: "hive-1", title: "Govern memory", status: "active" }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "memory-1" }])
      .mockResolvedValueOnce([{ id: "completion-1" }]);
    tx.json = vi.fn((value) => value);

    sql.mockResolvedValueOnce([{ project_id: null, project_git_repo: false }]);
    sql.begin = vi.fn(async (callback) => callback(tx));

    mocks.assertHiveMemoryWriteAllowed.mockResolvedValue({ allowed: true });
    mocks.verifyLandedState.mockResolvedValue({ ok: true });
  });

  it("updates governance last_write_at after a goal-completion memory write", async () => {
    await completeGoal(sql as never, "goal-1", "Completed with evidence.", {
      createdBy: "goal-supervisor",
    });

    expect(mocks.assertHiveMemoryWriteAllowed).toHaveBeenCalledWith(tx, {
      hiveId: "hive-1",
      source: "goals_complete_goal",
      operation: "write",
    });
    expect(mocks.markMemoryWritten).toHaveBeenCalledWith(tx, "hive-1");
    expect(mocks.markMemoryWritten.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.mock.invocationCallOrder[4],
    );
  });
});
