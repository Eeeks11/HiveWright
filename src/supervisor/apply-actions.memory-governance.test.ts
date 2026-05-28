import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertHiveMemoryWriteAllowed: vi.fn(),
  markMemoryWritten: vi.fn(),
  recordAgentAuditEventBestEffort: vi.fn(),
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

import { applySupervisorActions } from "./apply-actions";

describe("applySupervisorActions memory governance", () => {
  const sql = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "memory-1" }]);
    mocks.assertHiveMemoryWriteAllowed.mockResolvedValue({ allowed: true });
  });

  it("updates governance last_write_at after a supervisor insight memory write", async () => {
    const outcomes = await applySupervisorActions(sql as never, "hive-1", {
      summary: "Apply insight",
      findings_addressed: [],
      actions: [{
        kind: "log_insight",
        category: "governance",
        content: "Memory status should reflect governed writes.",
      }],
    });

    expect(outcomes).toEqual([{
      action: {
        kind: "log_insight",
        category: "governance",
        content: "Memory status should reflect governed writes.",
      },
      status: "applied",
      detail: "log_insight(governance): logged to hive_memory",
    }]);
    expect(mocks.assertHiveMemoryWriteAllowed).toHaveBeenCalledWith(sql, {
      hiveId: "hive-1",
      source: "supervisor_log_insight",
      operation: "write",
    });
    expect(mocks.markMemoryWritten).toHaveBeenCalledWith(sql, "hive-1");
    expect(mocks.markMemoryWritten.mock.invocationCallOrder[0]).toBeGreaterThan(
      sql.mock.invocationCallOrder[2],
    );
  });
});
