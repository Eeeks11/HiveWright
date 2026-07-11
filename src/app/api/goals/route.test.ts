import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { unsafe: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
    canMutateHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
  canMutateHive: mocks.canMutateHive,
}));

import { GET, POST } from "./route";

describe("GET /api/goals access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.sql.mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mocks.sql.unsafe.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before querying goals", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/goals"));

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects non-owner callers that request an inaccessible hiveId", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/goals?hiveId=11111111-1111-4111-8111-111111111111"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects missing hiveId even for non-owner goal reads", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });

    const res = await GET(new Request("http://localhost/api/goals?limit=10&offset=0"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects invalid hiveId before querying goals", async () => {
    const res = await GET(new Request("http://localhost/api/goals?hiveId=not-a-uuid"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must be a valid UUID");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("allows system-owner callers to request a hiveId without membership checks", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "1" }])
      .mockResolvedValueOnce([{
        id: "goal-1",
        hive_id: "11111111-1111-4111-8111-111111111111",
        project_id: null,
        parent_id: null,
        title: "Goal 1",
        description: null,
        status: "paused",
        budget_cents: 1000,
        spent_cents: 1000,
        budget_state: "paused",
        budget_warning_triggered_at: new Date("2026-04-27T00:00:00Z"),
        budget_enforced_at: new Date("2026-04-27T00:10:00Z"),
        budget_enforcement_reason: "Paused by budget",
        session_id: null,
        created_at: new Date("2026-04-27T00:00:00Z"),
        updated_at: new Date("2026-04-27T00:10:00Z"),
        archived_at: null,
        total_tasks: "2",
        completed_tasks: "1",
      }]);

    const res = await GET(new Request("http://localhost/api/goals?hiveId=11111111-1111-4111-8111-111111111111"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].budget).toMatchObject({
      capCents: 1000,
      spentCents: 1000,
      remainingCents: 0,
      percentUsed: 100,
      warning: true,
      paused: true,
      state: "paused",
      reason: "Paused by budget",
    });
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("allows system-owner callers to request a hiveId without membership checks", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/goals?hiveId=11111111-1111-4111-8111-111111111111"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});

describe("POST /api/goals mutation access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "viewer-1", email: "viewer@example.com", isSystemOwner: false },
    });
  });

  it("rejects a read-only viewer before creation side effects", async () => {
    mocks.canMutateHive.mockResolvedValueOnce(false);
    const res = await POST(new Request("http://localhost/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hiveId: "11111111-1111-4111-8111-111111111111",
        title: "Viewer must not create",
      }),
    }));

    expect(res.status).toBe(403);
    expect(mocks.canMutateHive).toHaveBeenCalledWith(
      mocks.sql,
      "viewer-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });
});
