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
  return new Request(`http://localhost/api/marketing/campaigns/${CAMPAIGN_ID}/start`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({ user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true } });
  mocks.canMutateHive.mockResolvedValue(true);
});

describe("POST /api/marketing/campaigns/[campaignId]/start", () => {
  it("starts a paid ads campaign only from a persisted owner-approved cap", async () => {
    mocks.sql.mockResolvedValueOnce([
      {
        id: CAMPAIGN_ID,
        hive_id: HIVE_ID,
        status: "running",
        spend_budget_cents: 50000,
        approval_policy: { paidAdsBudgetApproval: { approvalStatus: "approved", requestedBudgetCents: 50000, ownerId: "owner-1" } },
      },
    ]);

    const res = await POST(request({ hiveId: HIVE_ID }), { params: Promise.resolve({ campaignId: CAMPAIGN_ID }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.campaign).toMatchObject({ id: CAMPAIGN_ID, status: "running", spendBudgetCents: 50000 });
    expect(String(mocks.sql.mock.calls[0][0])).toContain("paidAdsBudgetApproval");
    expect(String(mocks.sql.mock.calls[0][0])).toContain("AND status = 'approved'");
    expect(String(mocks.sql.mock.calls[0][0])).toContain("INSERT INTO marketing_execution_logs");
  });

  it("does not start spend when explicit cap and approval are missing", async () => {
    mocks.sql.mockResolvedValueOnce([]);

    const res = await POST(request({ hiveId: HIVE_ID }), { params: Promise.resolve({ campaignId: CAMPAIGN_ID }) });

    expect(res.status).toBe(409);
  });
});
