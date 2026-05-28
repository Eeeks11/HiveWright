import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
  getMemoryEntryScope: vi.fn(),
  softDeleteMemoryEntry: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/memory/governance", () => ({
  getMemoryEntryScope: mocks.getMemoryEntryScope,
  softDeleteMemoryEntry: mocks.softDeleteMemoryEntry,
}));

import { DELETE } from "./route";
import { sql } from "../../_lib/db";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

describe("DELETE /api/memory/entries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.getMemoryEntryScope.mockResolvedValue({
      id: "memory-1",
      hiveId: "hive-1",
      store: "hive_memory",
    });
    mocks.softDeleteMemoryEntry.mockResolvedValue({
      id: "memory-1",
      hiveId: "hive-1",
      store: "hive_memory",
      status: "soft_deleted",
      deletedAt: "2026-05-29T02:30:00.000Z",
    });
  });

  it("denies cross-hive deletion before mutating memory entries", async () => {
    mocks.getMemoryEntryScope.mockResolvedValueOnce({
      id: "memory-1",
      hiveId: "hive-2",
      store: "hive_memory",
    });
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await DELETE(new Request("http://localhost/api/memory/entries", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "memory-1", store: "hive_memory" }),
    }));

    expect(res.status).toBe(403);
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-2");
    expect(mocks.softDeleteMemoryEntry).not.toHaveBeenCalled();
  });

  it("returns a sanitized delete payload without raw memory content", async () => {
    const res = await DELETE(new Request("http://localhost/api/memory/entries", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "memory-1", store: "hive_memory", reason: "No longer needed" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "memory-1",
      hiveId: "hive-1",
      store: "hive_memory",
      status: "soft_deleted",
    });
    expect(JSON.stringify(body.data)).not.toMatch(/content|secret|password/i);
  });
});
