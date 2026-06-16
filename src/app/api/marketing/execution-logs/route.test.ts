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

vi.mock("../../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({ canMutateHive: mocks.canMutateHive }));

import { POST } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";
const ASSET_ID = "33333333-3333-3333-3333-333333333333";
const ACTION_ID = "44444444-4444-4444-4444-444444444444";
const DECISION_ID = "55555555-5555-5555-5555-555555555555";
const LOG_ID = "66666666-6666-6666-6666-666666666666";

function request(assetId = ASSET_ID) {
  return new Request("http://localhost/api/marketing/execution-logs", {
    method: "POST",
    body: JSON.stringify({ assetId, action: "manual_owner_approved_marketing_execution", connector: "manual_import" }),
  });
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    hive_id: HIVE_ID,
    campaign_id: CAMPAIGN_ID,
    external_action_request_id: ACTION_ID,
    external_action_decision_id: DECISION_ID,
    approval_status: "approved",
    external_action_state: "approved",
    decision_status: "resolved",
    selected_option_key: "approve",
    ...overrides,
  };
}

function logRow() {
  return {
    id: LOG_ID,
    hive_id: HIVE_ID,
    campaign_id: CAMPAIGN_ID,
    asset_id: ASSET_ID,
    external_action_request_id: ACTION_ID,
    action: "manual_owner_approved_marketing_execution",
    connector: "manual_import",
    executed_at: new Date("2026-06-16T02:00:00Z"),
    trace: ["asset_drafted", "owner_approved", "execution_logged"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({ user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true } });
  mocks.canMutateHive.mockResolvedValue(true);
  mocks.sql.begin.mockImplementation(async (callback: (tx: typeof mocks.tx) => Promise<unknown>) => callback(mocks.tx));
});

describe("POST /api/marketing/execution-logs", () => {
  it("rejects unapproved or rejected assets before creating an execution log", async () => {
    mocks.sql.mockResolvedValueOnce([assetRow({ approval_status: "rejected", external_action_state: "rejected", selected_option_key: "reject" })]);

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect(mocks.sql.begin).not.toHaveBeenCalled();
  });

  it("creates a traceable execution log and final state atomically after owner approval", async () => {
    mocks.sql.mockResolvedValueOnce([assetRow()]);
    mocks.tx
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([logRow()])
      .mockResolvedValueOnce([{ id: ACTION_ID }])
      .mockResolvedValueOnce([{ id: ASSET_ID }])
      .mockResolvedValueOnce([{ id: CAMPAIGN_ID }]);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.executionLog).toMatchObject({
      id: LOG_ID,
      hiveId: HIVE_ID,
      campaignId: CAMPAIGN_ID,
      assetId: ASSET_ID,
      externalActionRequestId: ACTION_ID,
    });
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(5);
  });

  it("is idempotent when an approved asset already has an execution log", async () => {
    mocks.sql.mockResolvedValueOnce([assetRow({ external_action_state: "succeeded" })]);
    mocks.tx.mockResolvedValueOnce([logRow()]);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.executionLog.id).toBe(LOG_ID);
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(1);
  });

  it("repairs the finality gap when a prior retry marked the request succeeded but lost the execution log", async () => {
    mocks.sql.mockResolvedValueOnce([assetRow({ external_action_state: "succeeded" })]);
    mocks.tx
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([logRow()])
      .mockResolvedValueOnce([{ id: ACTION_ID }])
      .mockResolvedValueOnce([{ id: ASSET_ID }])
      .mockResolvedValueOnce([{ id: CAMPAIGN_ID }]);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.executionLog.id).toBe(LOG_ID);
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
  });

  it("does not create a second execution log when a concurrent retry hits the unique external-action request key", async () => {
    mocks.sql.mockResolvedValueOnce([assetRow()]);
    mocks.tx
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([logRow()])
      .mockResolvedValueOnce([{ id: ACTION_ID }])
      .mockResolvedValueOnce([{ id: ASSET_ID }])
      .mockResolvedValueOnce([{ id: CAMPAIGN_ID }]);

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.executionLog.id).toBe(LOG_ID);
    expect(mocks.tx.mock.calls[1][0].join(" ")).toContain("ON CONFLICT (external_action_request_id)");
  });

  it("rolls back execution finality if the traceable log cannot be returned", async () => {
    mocks.sql.mockResolvedValueOnce([assetRow()]);
    mocks.tx
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.tx).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-hive callers that cannot mutate the asset hive", async () => {
    mocks.requireApiUser.mockResolvedValue({ user: { id: "member-1", email: "member@example.com", isSystemOwner: false } });
    mocks.canMutateHive.mockResolvedValue(false);
    mocks.sql.mockResolvedValueOnce([assetRow()]);

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "member-1", HIVE_ID);
    expect(mocks.sql.begin).not.toHaveBeenCalled();
  });
});
