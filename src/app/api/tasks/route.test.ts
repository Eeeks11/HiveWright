import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { unsafe: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    requireSystemOwner: vi.fn(),
    enforceInternalTaskHiveScope: vi.fn(),
    isInternalServiceAccountUser: vi.fn(),
    canAccessHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
  enforceInternalTaskHiveScope: mocks.enforceInternalTaskHiveScope,
  isInternalServiceAccountUser: mocks.isInternalServiceAccountUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET, POST } from "./route";

describe("GET /api/tasks access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.enforceInternalTaskHiveScope.mockResolvedValue({ ok: true, scope: null });
    mocks.sql.mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mocks.sql.unsafe.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before querying tasks", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/tasks"));

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects non-owner callers that request an inaccessible hiveId", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/tasks?hiveId=11111111-1111-4111-8111-111111111111"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects missing hiveId even for non-owner task reads", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });

    const res = await GET(new Request("http://localhost/api/tasks?limit=10&offset=0"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects invalid hiveId before querying tasks", async () => {
    const res = await GET(new Request("http://localhost/api/tasks?hiveId=not-a-uuid"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must be a valid UUID");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("allows system-owner callers to request a hiveId without membership checks", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks?hiveId=11111111-1111-4111-8111-111111111111"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});

describe("POST /api/tasks payload compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.enforceInternalTaskHiveScope.mockResolvedValue({ ok: true, scope: null });
    mocks.sql.mockReset();
  });

  it("accepts snake_case task-create fields used by agent tool contracts", async () => {
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([
        {
          id: "task-1",
          hive_id: "11111111-1111-4111-8111-111111111111",
          assigned_to: "dev-agent",
          created_by: "goal-supervisor",
          status: "pending",
          priority: 5,
          title: "Implement cost reporting",
          brief: "Add the reporting fields.",
          parent_task_id: null,
          goal_id: "goal-1",
          project_id: null,
          sprint_number: 2,
          qa_required: true,
          acceptance_criteria: "Cost report separates fresh, cached, and output tokens.",
          result_summary: null,
          retry_count: 0,
          doctor_attempts: 0,
          failure_reason: null,
          tokens_input: null,
          tokens_output: null,
          cost_cents: null,
          model_used: null,
          started_at: null,
          completed_at: null,
          created_at: new Date("2026-05-06T00:00:00Z"),
          updated_at: new Date("2026-05-06T00:00:00Z"),
        },
      ]);

    const res = await POST(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: "11111111-1111-4111-8111-111111111111",
        assigned_to: "dev-agent",
        title: "Implement cost reporting",
        brief: "Add the reporting fields.",
        goal_id: "goal-1",
        sprint_number: 2,
        qa_required: true,
        created_by: "system",
        acceptance_criteria: "Cost report separates fresh, cached, and output tokens.",
      }),
    }));

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      assignedTo: "dev-agent",
      createdBy: "goal-supervisor",
      goalId: "goal-1",
      sprintNumber: 2,
      qaRequired: true,
      acceptanceCriteria: "Cost report separates fresh, cached, and output tokens.",
    });
  });
});
