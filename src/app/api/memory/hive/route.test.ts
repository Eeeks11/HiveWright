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
}));

import { canMutateHive } from "@/auth/users";
import { enforceInternalTaskHiveScope, requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { POST } from "./route";

const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
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
});
