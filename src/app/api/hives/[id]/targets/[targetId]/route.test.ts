import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../_lib/db", () => ({
  sql: Object.assign(vi.fn(), { begin: vi.fn() }),
}));

vi.mock("../../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

import { canAccessHive, canMutateHive } from "@/auth/users";
import { requireApiUser } from "../../../../_lib/auth";
import { sql } from "../../../../_lib/db";
import { PATCH } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const HIVE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HIVE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const params = { params: Promise.resolve({ id: HIVE_ID, targetId: TARGET_ID }) };
const targetRow = {
  id: TARGET_ID,
  hive_id: HIVE_ID,
  title: "Updated target",
  target_value: null,
  deadline: null,
  notes: null,
  sort_order: 0,
  status: "open",
  created_at: new Date("2026-05-01T00:00:00.000Z"),
  updated_at: new Date("2026-05-01T00:00:00.000Z"),
};

describe("PATCH /api/hives/[id]/targets/[targetId] target consistency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
    mockCanMutateHive.mockResolvedValue(true);
  });

  it("returns 401 for signed-out callers before parsing a mismatched body hiveId", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await PATCH(
      new Request(`http://localhost/api/hives/${HIVE_ID}/targets/${TARGET_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ hiveId: OTHER_HIVE_ID, title: "Wrong hive" }),
      }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
    expect(mockCanMutateHive).not.toHaveBeenCalled();
  });

  it("rejects a mismatched body hiveId after path hive authorization but before nested resource lookup", async () => {
    mockSql.mockResolvedValueOnce([{ id: HIVE_ID }]);

    const res = await PATCH(
      new Request(`http://localhost/api/hives/${HIVE_ID}/targets/${TARGET_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ hiveId: OTHER_HIVE_ID, title: "Wrong hive" }),
      }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must match path hive id");
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCanAccessHive).not.toHaveBeenCalled();
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_ID);
  });

  it("fails closed when the nested target belongs to another hive", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: HIVE_ID }])
      .mockResolvedValueOnce([]);

    const res = await PATCH(
      new Request(`http://localhost/api/hives/${HIVE_ID}/targets/${TARGET_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated target" }),
      }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("target not found");
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("accepts matching body hiveId for a same-hive target", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: HIVE_ID }])
      .mockResolvedValueOnce([{ id: TARGET_ID }])
      .mockReturnValueOnce("updates-fragment")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([targetRow]);

    const res = await PATCH(
      new Request(`http://localhost/api/hives/${HIVE_ID}/targets/${TARGET_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ hiveId: HIVE_ID, title: "Updated target" }),
      }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(expect.objectContaining({ id: TARGET_ID, hiveId: HIVE_ID, title: "Updated target" }));
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_ID);
  });
});
