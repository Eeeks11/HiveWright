import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertHiveMemoryWriteAllowed: vi.fn(),
  markMemoryWritten: vi.fn(),
  proposeSkill: vi.fn(),
}));

vi.mock("@/memory/governance", () => ({
  assertHiveMemoryWriteAllowed: mocks.assertHiveMemoryWriteAllowed,
  markMemoryWritten: mocks.markMemoryWritten,
}));

vi.mock("@/skills/self-creation", () => ({
  proposeSkill: mocks.proposeSkill,
}));

import { createLearningGateFollowup } from "./learning-gate-followup";

describe("createLearningGateFollowup memory governance", () => {
  const sql = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
    mocks.assertHiveMemoryWriteAllowed.mockResolvedValue({ allowed: true });
  });

  it("updates governance last_write_at after a learning memory write", async () => {
    await createLearningGateFollowup(sql as never, {
      goalId: "goal-1",
      hiveId: "hive-1",
      goalTitle: "Ship memory governance",
      completionSummary: "Baseline controls were shipped.",
      learningGate: {
        category: "memory",
        rationale: "Retain the operating lesson.",
        action: "Use timestamped memory status after governed writes.",
      },
    });

    expect(mocks.assertHiveMemoryWriteAllowed).toHaveBeenCalledWith(sql, {
      hiveId: "hive-1",
      source: "learning_gate_followup",
      operation: "write",
    });
    expect(mocks.markMemoryWritten).toHaveBeenCalledWith(sql, "hive-1");
    expect(mocks.markMemoryWritten.mock.invocationCallOrder[0]).toBeGreaterThan(
      sql.mock.invocationCallOrder[0],
    );
  });
});
