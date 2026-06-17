import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("../../../../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../../../../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({ canMutateHive: mocks.canMutateHive }));

import { POST } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";

function request(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/marketing/campaigns/${CAMPAIGN_ID}/policy-evaluation`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({ user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true } });
  mocks.canMutateHive.mockResolvedValue(true);
});

describe("POST /api/marketing/campaigns/[campaignId]/policy-evaluation", () => {
  it("applies persisted pause decisions when paid campaign metrics breach policy", async () => {
    mocks.sql.mockResolvedValueOnce([
      {
        id: CAMPAIGN_ID,
        hive_id: HIVE_ID,
        status: "paused",
        spend_budget_cents: 50000,
        decision: {
          campaignId: CAMPAIGN_ID,
          rule: "pause",
          recommendedStatus: "paused",
          reasons: ["Cost per lead 10000c exceeds policy cap 5000c."],
          metrics: { adSpendCents: 40000, spendBudgetCents: 50000, costPerLeadCents: 10000, leadQualityRate: 0.5, leadToBookingRate: 0.25 },
        },
      },
    ]);

    const res = await POST(request({ hiveId: HIVE_ID, maxCostPerLeadCents: 5000, minLeadQualityRate: 0.4, minLeadToBookingRate: 0.2 }), {
      params: Promise.resolve({ campaignId: CAMPAIGN_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.decision).toMatchObject({ rule: "pause", recommendedStatus: "paused" });
    expect(body.data.campaign).toMatchObject({ id: CAMPAIGN_ID, status: "paused" });
    expect(String(mocks.sql.mock.calls[0][0])).toContain("UPDATE marketing_campaigns");
    expect(String(mocks.sql.mock.calls[0][0])).toContain("INSERT INTO marketing_execution_logs");
    expect(String(mocks.sql.mock.calls[0][0])).toContain("ms.values ? 'ad_spend_cents'");
  });

  it("kills paid campaigns that exceed the owner-approved spend cap", async () => {
    mocks.sql.mockResolvedValueOnce([
      {
        id: CAMPAIGN_ID,
        hive_id: HIVE_ID,
        status: "killed",
        spend_budget_cents: 50000,
        decision: {
          campaignId: CAMPAIGN_ID,
          rule: "kill",
          recommendedStatus: "killed",
          reasons: ["Spend has reached the owner-approved budget cap."],
          metrics: { adSpendCents: 51000, spendBudgetCents: 50000, costPerLeadCents: 4250, leadQualityRate: 0.5, leadToBookingRate: 0.25 },
        },
      },
    ]);

    const res = await POST(request({ hiveId: HIVE_ID, maxCostPerLeadCents: 5000, minLeadQualityRate: 0.4, minLeadToBookingRate: 0.2 }), {
      params: Promise.resolve({ campaignId: CAMPAIGN_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.decision).toMatchObject({ rule: "kill", recommendedStatus: "killed" });
    expect(body.data.campaign).toMatchObject({ id: CAMPAIGN_ID, status: "killed" });
    expect(String(mocks.sql.mock.calls[0][0])).toContain("ad_spend_cents > spend_budget_cents");
  });
});
