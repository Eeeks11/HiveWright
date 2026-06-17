import { beforeEach, describe, expect, it, vi } from "vitest";

type SqlMock = ReturnType<typeof vi.fn> & { begin: ReturnType<typeof vi.fn> };

const mocks = vi.hoisted(() => {
  const txMock = vi.fn();
  const sql: SqlMock = Object.assign(vi.fn(), {
    begin: vi.fn(async (callback: (txClient: typeof txMock) => Promise<unknown>) => callback(txMock)),
  });
  return {
    sql,
    tx: txMock,
    requireApiUser: vi.fn(),
    canMutateHive: vi.fn(),
  };
});

vi.mock("../../../../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../../../../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({ canMutateHive: mocks.canMutateHive }));

import { POST } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";
const ASSET_ID = "33333333-3333-3333-3333-333333333333";
const ACTION_ID = "44444444-4444-4444-4444-444444444444";
const DECISION_ID = "55555555-5555-5555-5555-555555555555";

function decisionRequest(decision: "approved" | "rejected") {
  return new Request(`http://localhost/api/marketing/assets/${ASSET_ID}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, reason: "Owner checked brand voice" }),
  });
}

function context() {
  return { params: Promise.resolve({ assetId: ASSET_ID }) };
}

function pendingAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    hive_id: HIVE_ID,
    campaign_id: CAMPAIGN_ID,
    external_action_request_id: ACTION_ID,
    external_action_decision_id: DECISION_ID,
    approval_status: "pending_owner_approval",
    publication_status: "draft",
    external_action_state: "awaiting_approval",
    decision_kind: "external_action_approval",
    decision_status: "pending",
    owner_response: null,
    selected_option_key: null,
    channel: "seo",
    asset_type: "seo_content_brief",
    title: "SEO brief",
    draft_body: "Draft",
    scheduled_for: new Date("2026-06-17T00:00:00Z"),
    ...overrides,
  };
}

function decidedAsset(decision: "approved" | "rejected") {
  return pendingAsset({
    approval_status: decision,
    publication_status: decision === "approved" ? "queued" : "blocked",
    external_action_state: decision,
    decision_status: "resolved",
    owner_response: `${decision}: Owner checked brand voice`,
    selected_option_key: decision === "approved" ? "approve" : "reject",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({ user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true } });
  mocks.canMutateHive.mockResolvedValue(true);
  mocks.sql.begin.mockImplementation(async (callback: (tx: typeof mocks.tx) => Promise<unknown>) => callback(mocks.tx));
});

describe("POST /api/marketing/assets/[assetId]/decision", () => {
  it("approves an asset inside one owner-decision transaction and links the external action request", async () => {
    mocks.sql.mockResolvedValueOnce([pendingAsset()]);
    mocks.tx
      .mockResolvedValueOnce([pendingAsset()])
      .mockResolvedValueOnce([{ id: DECISION_ID }])
      .mockResolvedValueOnce([{ id: ACTION_ID, state: "approved", reviewed_by: "owner-1" }])
      .mockResolvedValueOnce([decidedAsset("approved")])
      .mockResolvedValueOnce([{ id: CAMPAIGN_ID }]);

    const res = await POST(decisionRequest("approved"), context());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.asset).toMatchObject({ id: ASSET_ID, approvalStatus: "approved", publicationStatus: "queued", externalActionRequestId: ACTION_ID });
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(5);
  });

  it("rejects an asset inside the same transaction as the decision and external action request", async () => {
    mocks.sql.mockResolvedValueOnce([pendingAsset()]);
    mocks.tx
      .mockResolvedValueOnce([pendingAsset()])
      .mockResolvedValueOnce([{ id: DECISION_ID }])
      .mockResolvedValueOnce([{ id: ACTION_ID, state: "rejected", reviewed_by: "owner-1" }])
      .mockResolvedValueOnce([decidedAsset("rejected")]);

    const res = await POST(decisionRequest("rejected"), context());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.asset).toMatchObject({ id: ASSET_ID, approvalStatus: "rejected", publicationStatus: "blocked" });
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(4);
  });

  it.each(["approved", "rejected"] as const)("treats duplicate %s owner decisions as idempotent when the recorded response matches", async (decision) => {
    mocks.sql.mockResolvedValueOnce([decidedAsset(decision)]);

    const res = await POST(decisionRequest(decision), context());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.asset).toMatchObject({ id: ASSET_ID, approvalStatus: decision });
    expect(mocks.sql.begin).not.toHaveBeenCalled();
  });

  it("rolls the owner decision transaction back when any finality update cannot be recorded", async () => {
    mocks.sql.mockResolvedValueOnce([pendingAsset()]);
    mocks.tx
      .mockResolvedValueOnce([pendingAsset()])
      .mockResolvedValueOnce([{ id: DECISION_ID }])
      .mockResolvedValueOnce([]);

    const res = await POST(decisionRequest("approved"), context());

    expect(res.status).toBe(409);
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(3);
  });

  it("rolls the owner decision transaction back when the approved campaign state cannot be recorded", async () => {
    mocks.sql.mockResolvedValueOnce([pendingAsset()]);
    mocks.tx
      .mockResolvedValueOnce([pendingAsset()])
      .mockResolvedValueOnce([{ id: DECISION_ID }])
      .mockResolvedValueOnce([{ id: ACTION_ID, state: "approved", reviewed_by: "owner-1" }])
      .mockResolvedValueOnce([decidedAsset("approved")])
      .mockResolvedValueOnce([]);

    const res = await POST(decisionRequest("approved"), context());

    expect(res.status).toBe(409);
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(5);
  });
});
