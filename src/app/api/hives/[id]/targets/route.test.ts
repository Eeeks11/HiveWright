import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

import { canAccessHive, canMutateHive } from "@/auth/users";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { GET, POST } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const HIVE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HIVE_ID = "22222222-2222-4222-8222-222222222222";
const params = { params: Promise.resolve({ id: HIVE_ID }) };
const targetRow = {
  id: "target-1",
  hive_id: HIVE_ID,
  title: "Ship secure reads",
  target_value: "All patched routes covered",
  deadline: null,
  notes: null,
  sort_order: 0,
  status: "open",
  created_at: new Date("2026-05-01T00:00:00.000Z"),
  updated_at: new Date("2026-05-01T00:00:00.000Z"),
};

describe("GET /api/hives/[id]/targets access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
    mockCanMutateHive.mockResolvedValue(true);
  });

  it("returns 401 for signed-out callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request(`http://localhost/api/hives/${HIVE_ID}/targets`), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the requested hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: HIVE_ID }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request(`http://localhost/api/hives/${HIVE_ID}/targets`), params);

    expect(res.status).toBe(403);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_ID);
  });

  it("returns 200 for a caller with access to the requested hive", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: HIVE_ID }])
      .mockResolvedValueOnce([targetRow]);

    const res = await GET(new Request(`http://localhost/api/hives/${HIVE_ID}/targets`), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "target-1",
        hiveId: HIVE_ID,
        title: "Ship secure reads",
      }),
    ]);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_ID);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched query hiveId before DB access", async () => {
    const res = await GET(new Request(`http://localhost/api/hives/${HIVE_ID}/targets?hiveId=${OTHER_HIVE_ID}`), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must match path hive id");
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("rejects a mismatched body hiveId before creating a target", async () => {
    const res = await POST(
      new Request(`http://localhost/api/hives/${HIVE_ID}/targets`, {
        method: "POST",
        body: JSON.stringify({ hiveId: OTHER_HIVE_ID, title: "Wrong hive" }),
      }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must match path hive id");
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });
});
