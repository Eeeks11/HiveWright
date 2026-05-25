import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
  promoteInsightToInstruction: vi.fn(),
}));

vi.mock("../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/standing-instructions/manager", () => ({
  promoteInsightToInstruction: mocks.promoteInsightToInstruction,
}));

import { PATCH } from "./route";

const params = { params: Promise.resolve({ id: "insight-1" }) };

describe("PATCH /api/insights/[id] access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValue(true);
  });

  it("returns 403 before mutating when the caller cannot manage the insight hive", async () => {
    mocks.sql.mockResolvedValueOnce([
      { id: "insight-1", hive_id: "hive-1", status: "new", decision_id: null },
    ]);
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const response = await PATCH(
      new Request("http://localhost/api/insights/insight-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "actioned", note: "Do it" }),
      }),
      params,
    );

    expect(response.status).toBe(403);
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
    expect(mocks.promoteInsightToInstruction).not.toHaveBeenCalled();
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
});
