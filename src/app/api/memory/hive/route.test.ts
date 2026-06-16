import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  enforceInternalTaskHiveScope: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: vi.fn(),
}));

vi.mock("@/ea/native/hive-switch-audit", () => ({
  maybeRecordEaHiveSwitch: vi.fn(),
  requireEaDestinationHiveConfirmation: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/memory/governance", () => ({
  assertHiveMemoryWriteAllowed: vi.fn(),
  markMemoryWritten: vi.fn(),
  memoryGovernanceDisabledResponse: vi.fn((governance) => new Response(JSON.stringify({
    error: `Hive memory is disabled${governance?.reason ? `: ${governance.reason}` : ""}`,
  }), { status: 423 })),
}));

import { canMutateHive } from "@/auth/users";
import { assertHiveMemoryWriteAllowed } from "@/memory/governance";
import { enforceInternalTaskHiveScope, requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { POST } from "./route";

const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockAssertHiveMemoryWriteAllowed = assertHiveMemoryWriteAllowed as unknown as ReturnType<typeof vi.fn>;
const mockEnforceInternalTaskHiveScope = enforceInternalTaskHiveScope as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

describe("POST /api/memory/hive access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockEnforceInternalTaskHiveScope.mockResolvedValue({ ok: true, scope: null });
    mockCanMutateHive.mockResolvedValue(true);
    mockAssertHiveMemoryWriteAllowed.mockResolvedValue({
      allowed: true,
      governance: {
        hiveId: "hive-1",
        memoryEnabled: true,
      },
    });
  });

  it("returns 403 before inserting when the caller cannot manage the hive", async () => {
    mockCanMutateHive.mockResolvedValueOnce(false);

    const response = await POST(new Request("http://localhost/api/memory/hive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hiveId: "hive-1", content: "Cross-hive memory" }),
    }));

    expect(response.status).toBe(403);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 423 and skips inserts when hive memory is disabled", async () => {
    mockAssertHiveMemoryWriteAllowed.mockResolvedValueOnce({
      allowed: false,
      governance: {
        hiveId: "hive-1",
        memoryEnabled: false,
        reason: "Owner paused memory",
      },
    });

    const response = await POST(new Request("http://localhost/api/memory/hive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hiveId: "hive-1", content: "Blocked memory write" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(423);
    expect(body.error).toMatch(/memory is disabled/i);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
