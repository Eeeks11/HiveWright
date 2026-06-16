import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("../../../../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../../../../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));

import { POST } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";

function request(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/marketing/campaigns/${CAMPAIGN_ID}/budget`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({ user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true } });
});

describe("POST /api/marketing/campaigns/[campaignId]/budget", () => {
  it("persists an owner-approved paid ads cap with policy snapshot before spend can start", async () => {
    mocks.sql.mockResolvedValueOnce([
      {
        id: CAMPAIGN_ID,
        hive_id: HIVE_ID,
        status: "approved",
        spend_budget_cents: 50000,
        approval_policy: {
          paidAdsBudgetApproval: {
            approvalStatus: "approved",
            requestedBudgetCents: 50000,
            ownerId: "owner-1",
            policySnapshot: { spendCapRequired: true, ownerApprovalRequired: true, pauseOrKillRulesRequired: true },
          },
        },
      },
    ]);

    const res = await POST(request({ hiveId: HIVE_ID, requestedBudgetCents: 50000, reason: "bounded Lakes test" }), {
      params: Promise.resolve({ campaignId: CAMPAIGN_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.campaign).toMatchObject({ id: CAMPAIGN_ID, status: "approved", spendBudgetCents: 50000 });
    expect(body.data.budgetApproval).toMatchObject({ approvalStatus: "approved", requestedBudgetCents: 50000, ownerId: "owner-1" });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(String(mocks.sql.mock.calls[0][0])).toContain("UPDATE marketing_campaigns");
    expect(JSON.stringify(mocks.sql.mock.calls[0])).toContain("paidAdsBudgetApproval");
  });

  it("rejects zero or missing paid ads budget caps", async () => {
    const res = await POST(request({ hiveId: HIVE_ID, requestedBudgetCents: 0 }), {
      params: Promise.resolve({ campaignId: CAMPAIGN_ID }),
    });

    expect(res.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects non-owner hive members for paid ads budget approval", async () => {
    mocks.requireApiUser.mockResolvedValue({ user: { id: "33333333-3333-3333-3333-333333333333", email: "member@example.com", isSystemOwner: false } });
    mocks.sql.mockResolvedValueOnce([{ c: 0 }]);

    const res = await POST(request({ hiveId: HIVE_ID, requestedBudgetCents: 50000 }), {
      params: Promise.resolve({ campaignId: CAMPAIGN_ID }),
    });

    expect(res.status).toBe(403);
    expect(String(mocks.sql.mock.calls[0][0])).toContain("role = 'owner'");
  });
});
