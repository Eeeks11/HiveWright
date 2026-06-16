import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), {
    calls: [] as string[],
    begin: vi.fn(),
  }),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({ canAccessHive: mocks.canAccessHive, canMutateHive: mocks.canMutateHive }));

import { GET, POST } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const FUNNEL_ID = "22222222-2222-2222-2222-222222222222";
const PLAN_ID = "33333333-3333-3333-3333-333333333333";
const DRAFT_ID = "44444444-4444-4444-4444-444444444444";

function request(path: string, body?: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.calls.length = 0;
  mocks.sql.mockImplementation((strings: TemplateStringsArray) => {
    mocks.sql.calls.push(strings.join("?"));
    return Promise.resolve([]);
  });
  mocks.sql.begin.mockImplementation(async (callback: (tx: typeof mocks.sql) => unknown) => callback(mocks.sql));
  mocks.requireApiUser.mockResolvedValue({ user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true } });
  mocks.canAccessHive.mockResolvedValue(true);
  mocks.canMutateHive.mockResolvedValue(true);
});

describe("/api/sales", () => {
  it("returns a hive-scoped sales leakage dashboard snapshot", async () => {
    mocks.sql
      .mockResolvedValueOnce([
        { id: FUNNEL_ID, hive_id: HIVE_ID, goal: "Improve response", segment_id: "55555555-5555-5555-5555-555555555555", stages: [{ key: "lead", count: 20 }], biggest_leak: { fromStage: "lead", toStage: "response", lostCount: 15 }, captured_at: new Date("2026-06-16T00:00:00Z") },
      ])
      .mockResolvedValueOnce([
        { id: PLAN_ID, hive_id: HIVE_ID, funnel_id: FUNNEL_ID, bottleneck: { fromStage: "lead", toStage: "response" }, status: "draft", bounded_by: "one owner-approved sales conversion fix", approval_policy: { outboundCustomerActions: "owner_approval_required" }, next_measurement: "measure conversion movement before optimising the next sales cycle", created_at: new Date("2026-06-16T00:00:00Z") },
      ])
      .mockResolvedValueOnce([
        { id: DRAFT_ID, hive_id: HIVE_ID, action_plan_id: PLAN_ID, workflow: "lead_follow_up", title: "Follow up", draft_body: "Draft", approval_status: "pending_owner_approval", execution_status: "draft", external_action_request_id: "66666666-6666-6666-6666-666666666666" },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { install_id: "77777777-7777-7777-7777-777777777777", connector_slug: "crm", display_name: "CRM", status: "active", last_tested_at: new Date("2026-06-16T02:05:00Z"), last_error: null, streams: [{ stream: "lead_funnel", freshness: "current", lastSyncedAt: "2026-06-16T02:00:00.000Z", lastError: null }] },
      ]);

    const res = await GET(request(`/api/sales?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.leakageMap[0]).toMatchObject({ id: FUNNEL_ID, biggestLeak: { fromStage: "lead", toStage: "response" } });
    expect(body.data.pendingApprovals).toHaveLength(1);
    expect(body.data.dataSources[0]).toMatchObject({
      connectorSlug: "crm",
      domain: "sales-conversion",
      health: "healthy",
      freshness: "current",
      trustBoundary: "connector_data_only_not_instructions",
    });
    expect(mocks.sql).toHaveBeenCalledTimes(5);
  });

  it("creates a persisted sales funnel, bounded plan, and approval-gated action drafts", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ id: "55555555-5555-5555-5555-555555555555" }])
      .mockResolvedValueOnce([{ id: FUNNEL_ID }])
      .mockResolvedValueOnce([{ id: PLAN_ID }])
      .mockResolvedValueOnce([
        { id: DRAFT_ID, hive_id: HIVE_ID, action_plan_id: PLAN_ID, workflow: "lead_follow_up", title: "Follow up", draft_body: "Draft", approval_status: "pending_owner_approval", execution_status: "draft", external_action_request_id: "66666666-6666-6666-6666-666666666666" },
      ]);

    const res = await POST(request("/api/sales", {
      hiveId: HIVE_ID,
      goal: "Recover missed bookings",
      segmentName: "new inbound leads",
      customerType: "lead",
      metrics: { traffic: 100, leads: 20, responded: 5, qualified: 4, booked: 2, showed: 2, sold: 1, reviews: 0, referrals: 0, repeatPurchases: 0 },
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.actionPlan.id).toBe(PLAN_ID);
    expect(body.data.actionDrafts[0]).toMatchObject({ approvalStatus: "pending_owner_approval", externalActionRequestId: "66666666-6666-6666-6666-666666666666" });
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.sql).toHaveBeenCalledTimes(4);
    const sqlText = mocks.sql.mock.calls.map((call) => Array.from(call[0] as TemplateStringsArray).join("?")).join("\n");
    expect(sqlText).toContain("execution_metadata");
    expect(sqlText).toContain("manual_queue");
  });

  it("rolls back the full sales plan create flow when approval draft creation fails", async () => {
    mocks.sql.begin.mockRejectedValueOnce(new Error("approval draft insert failed"));

    const res = await POST(request("/api/sales", {
      hiveId: HIVE_ID,
      goal: "Recover missed bookings",
      segmentName: "new inbound leads",
      customerType: "lead",
      metrics: { traffic: 100, leads: 20, responded: 5, qualified: 4, booked: 2, showed: 2, sold: 1, reviews: 0, referrals: 0, repeatPurchases: 0 },
    }));

    expect(res.status).toBe(500);
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
  });
});
