import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHiveMemoryGovernanceState: vi.fn(),
  recordMemoryBlockedOperation: vi.fn(),
}));

vi.mock("./governance", () => ({
  getHiveMemoryGovernanceState: mocks.getHiveMemoryGovernanceState,
  recordMemoryBlockedOperation: mocks.recordMemoryBlockedOperation,
}));

import { applyMemoryOperations } from "./operations";

describe("applyMemoryOperations", () => {
  const sql = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks automatic memory writes when governance disables memory", async () => {
    mocks.getHiveMemoryGovernanceState.mockResolvedValue({
      hiveId: "hive-1",
      memoryEnabled: false,
      reason: "Owner paused memory",
    });

    const results = await applyMemoryOperations(sql as never, [{
      operation: "ADD",
      store: "hive_memory",
      content: "Do not write this",
    }], {
      hiveId: "hive-1",
      roleSlug: "developer-agent",
      sourceTaskId: "task-1",
    });

    expect(results).toEqual([
      expect.objectContaining({
        applied: false,
        error: "Hive memory is disabled for this hive: Owner paused memory",
      }),
    ]);
    expect(mocks.recordMemoryBlockedOperation).toHaveBeenCalledWith(sql, {
      hiveId: "hive-1",
      source: "memory_operations",
      operation: "write",
      reason: "Owner paused memory",
    });
    expect(sql).not.toHaveBeenCalled();
  });
});
