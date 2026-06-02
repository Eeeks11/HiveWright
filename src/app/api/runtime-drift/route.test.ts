import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  buildRuntimeDriftOperatorReport: vi.fn(),
}));

vi.mock("../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({ canAccessHive: mocks.canAccessHive }));
vi.mock("@/operations/runtime-drift-report", () => ({
  buildRuntimeDriftOperatorReport: mocks.buildRuntimeDriftOperatorReport,
}));

import { GET } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";

function request(query = `?hiveId=${HIVE_ID}`) {
  return new Request(`http://localhost/api/runtime-drift${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({
    user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
  });
  mocks.canAccessHive.mockResolvedValue(true);
  mocks.buildRuntimeDriftOperatorReport.mockResolvedValue({ hiveId: HIVE_ID, routeDrift: { status: "in_sync" } });
});

describe("GET /api/runtime-drift", () => {
  it("returns 401 for signed-out callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.buildRuntimeDriftOperatorReport).not.toHaveBeenCalled();
  });

  it("returns 403 when a non-owner cannot access the hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", HIVE_ID);
    expect(mocks.buildRuntimeDriftOperatorReport).not.toHaveBeenCalled();
  });

  it("rejects missing hiveId", async () => {
    const res = await GET(request(""));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("hiveId");
    expect(mocks.buildRuntimeDriftOperatorReport).not.toHaveBeenCalled();
  });

  it("rejects malformed hiveId", async () => {
    const res = await GET(request("?hiveId=not-a-uuid"));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("UUID");
    expect(mocks.buildRuntimeDriftOperatorReport).not.toHaveBeenCalled();
  });

  it("returns the runtime drift report for an authorized caller", async () => {
    const res = await GET(request(`?hiveId=${HIVE_ID}&taskId=task-1`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ hiveId: HIVE_ID, routeDrift: { status: "in_sync" } });
    expect(mocks.buildRuntimeDriftOperatorReport).toHaveBeenCalledWith({
      sql: mocks.sql,
      hiveId: HIVE_ID,
      taskId: "task-1",
    });
  });
});
