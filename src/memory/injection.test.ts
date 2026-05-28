import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSimilar: vi.fn(),
  getHiveMemoryGovernanceState: vi.fn(),
  recordMemoryBlockedOperation: vi.fn(),
}));

vi.mock("./embeddings", () => ({
  findSimilar: mocks.findSimilar,
}));

vi.mock("./governance", () => ({
  getHiveMemoryGovernanceState: mocks.getHiveMemoryGovernanceState,
  recordMemoryBlockedOperation: mocks.recordMemoryBlockedOperation,
}));

import { queryRelevantMemory } from "./injection";

describe("queryRelevantMemory", () => {
  const sql = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSimilar.mockResolvedValue([]);
  });

  it("returns an explicit blocked label and skips memory reads when governance disables memory", async () => {
    mocks.getHiveMemoryGovernanceState.mockResolvedValue({
      hiveId: "hive-1",
      memoryEnabled: false,
      reason: "Owner paused memory",
      changedBy: "owner@example.com",
      updatedAt: "2026-05-29T01:00:00.000Z",
      lastUsedAt: null,
      lastWriteAt: null,
      lastBlockedAt: null,
      lastBlockedOperation: null,
      lastBlockedSource: null,
      blocked: false,
      recentlyUsed: false,
      statusLabels: ["disabled"],
    });

    const result = await queryRelevantMemory(sql as never, {
      roleSlug: "developer-agent",
      hiveId: "hive-1",
      department: "engineering",
      taskBrief: "Ship the governance slice",
      pgvectorEnabled: false,
    });

    expect(result.roleMemory).toEqual([]);
    expect(result.hiveMemory).toEqual([]);
    expect(result.insights).toEqual([]);
    expect(result.capacity).toBe("memory disabled");
    expect(result.governance).toMatchObject({
      memoryEnabled: false,
      statusLabel: "Status: disabled; same-hive memory reuse is blocked for this hive.",
      scopeLabel: "Scope: agent/session memory injection is disabled until the hive memory control is re-enabled.",
      blockedReason: "Owner paused memory",
    });
    expect(mocks.recordMemoryBlockedOperation).toHaveBeenCalledWith(sql, {
      hiveId: "hive-1",
      source: "memory_injection",
      operation: "read",
      reason: "Owner paused memory",
    });
    expect(sql).not.toHaveBeenCalled();
  });
});
