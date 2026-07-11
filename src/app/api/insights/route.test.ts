import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET } from "./route";

function request() {
  return new Request("http://localhost/api/insights?hiveId=11111111-1111-4111-8111-111111111111&status=new");
}

describe("GET /api/insights access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockReset();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]).mockResolvedValueOnce([]);
  });

  it("returns 401 for signed-out callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request() as never);

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request() as never);

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("returns 200 when the signed-in caller can access the hive", async () => {
    const res = await GET(request() as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mocks.sql).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when hiveId is missing", async () => {
    const res = await GET(new Request("http://localhost/api/insights?status=new") as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
