import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
  getHiveMemoryGovernanceSummary: vi.fn(),
  setHiveMemoryGovernanceState: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/memory/governance", () => ({
  getHiveMemoryGovernanceSummary: mocks.getHiveMemoryGovernanceSummary,
  setHiveMemoryGovernanceState: mocks.setHiveMemoryGovernanceState,
}));

import { GET, PATCH } from "./route";
import { sql } from "@/app/api/_lib/db";

const hiveId = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ id: hiveId }) };
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

describe("/api/hives/[id]/memory-governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.getHiveMemoryGovernanceSummary.mockResolvedValue({
      hiveId,
      memoryEnabled: false,
      reason: "Owner paused memory",
      changedBy: "owner@example.com",
      updatedAt: "2026-05-29T01:00:00.000Z",
      status: {
        enabled: false,
        disabled: true,
        blocked: true,
        recentlyUsed: false,
        labels: ["disabled", "blocked"],
      },
      activity: {
        lastUsedAt: null,
        lastWriteAt: null,
        lastBlockedAt: "2026-05-29T01:10:00.000Z",
        lastBlockedOperation: "write",
        lastBlockedSource: "memory_hive_api",
      },
      counts: {
        roleMemory: 4,
        hiveMemory: 3,
        deletedRoleMemory: 1,
        deletedHiveMemory: 2,
      },
      scopeLabel: "Scope: same-hive agent memory reuse and automatic writes only.",
    });
    mocks.setHiveMemoryGovernanceState.mockResolvedValue({
      hiveId,
      memoryEnabled: true,
      reason: null,
      changedBy: "user@example.com",
      updatedAt: "2026-05-29T02:00:00.000Z",
      status: {
        enabled: true,
        disabled: false,
        blocked: false,
        recentlyUsed: true,
        labels: ["enabled", "recently used"],
      },
      activity: {
        lastUsedAt: "2026-05-29T01:59:00.000Z",
        lastWriteAt: "2026-05-29T01:58:00.000Z",
        lastBlockedAt: null,
        lastBlockedOperation: null,
        lastBlockedSource: null,
      },
      counts: {
        roleMemory: 4,
        hiveMemory: 3,
        deletedRoleMemory: 1,
        deletedHiveMemory: 2,
      },
      scopeLabel: "Scope: same-hive agent memory reuse and automatic writes only.",
    });
  });

  it("denies status reads when the caller cannot access the hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request(`http://localhost/api/hives/${hiveId}/memory-governance`), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/hive access required/i);
    expect(mocks.getHiveMemoryGovernanceSummary).not.toHaveBeenCalled();
  });

  it("returns a sanitized governance status payload", async () => {
    const res = await GET(new Request(`http://localhost/api/hives/${hiveId}/memory-governance`), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      hiveId,
      memoryEnabled: false,
      counts: {
        roleMemory: 4,
        hiveMemory: 3,
      },
      status: {
        disabled: true,
        blocked: true,
      },
    });
    expect(JSON.stringify(body.data)).not.toMatch(/content|secret|password/i);
    expect(mocks.getHiveMemoryGovernanceSummary).toHaveBeenCalledWith(mockSql, hiveId);
  });

  it("denies governance mutations when the caller cannot manage the hive", async () => {
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await PATCH(new Request(`http://localhost/api/hives/${hiveId}/memory-governance`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, reason: "Incident response" }),
    }), params);

    expect(res.status).toBe(403);
    expect(mocks.setHiveMemoryGovernanceState).not.toHaveBeenCalled();
  });
});
