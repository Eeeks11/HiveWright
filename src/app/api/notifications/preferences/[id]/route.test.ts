import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: vi.fn(),
}));

import { canMutateHive } from "@/auth/users";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { DELETE } from "./route";

const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const params = { params: Promise.resolve({ id: "pref-1" }) };

describe("DELETE /api/notifications/preferences/[id] access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanMutateHive.mockResolvedValue(true);
  });

  it("returns 403 before deleting when the caller cannot manage the preference hive", async () => {
    mockSql.mockResolvedValueOnce([{ hive_id: "hive-1" }]);
    mockCanMutateHive.mockResolvedValueOnce(false);

    const response = await DELETE(
      new Request("http://localhost/api/notifications/preferences/pref-1", { method: "DELETE" }),
      params,
    );

    expect(response.status).toBe(403);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
