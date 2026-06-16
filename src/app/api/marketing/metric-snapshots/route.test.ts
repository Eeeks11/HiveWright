import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("../../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({ canMutateHive: mocks.canMutateHive }));

import { POST } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";
const METRIC_ID = "33333333-3333-3333-3333-333333333333";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/marketing/metric-snapshots", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({ user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true } });
  mocks.canMutateHive.mockResolvedValue(true);
});

describe("POST /api/marketing/metric-snapshots", () => {
  it("persists manual/imported campaign metrics so dashboard results can show owner-entered outcomes", async () => {
    mocks.sql.mockResolvedValueOnce([
      {
        id: METRIC_ID,
        hive_id: HIVE_ID,
        campaign_id: CAMPAIGN_ID,
        source: "manual_import",
        values: { impressions: 1200, clicks: 84, ctr: 0.07, landing_page_visits: 52 },
        attribution_confidence: "manual_unverified",
        freshness: "current",
        captured_at: new Date("2026-06-16T02:00:00Z"),
      },
    ]);

    const res = await POST(request({
      hiveId: HIVE_ID,
      campaignId: CAMPAIGN_ID,
      values: { impressions: 1200, clicks: 84, ctr: 0.07, landing_page_visits: 52, ignored: "not numeric" },
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.metricSnapshot).toMatchObject({
      id: METRIC_ID,
      campaignId: CAMPAIGN_ID,
      source: "manual_import",
      values: { impressions: 1200, clicks: 84, ctr: 0.07, landing_page_visits: 52 },
      attributionConfidence: "manual_unverified",
      freshness: "current",
    });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-hive callers that cannot mutate the metric hive", async () => {
    mocks.requireApiUser.mockResolvedValue({ user: { id: "member-1", email: "member@example.com", isSystemOwner: false } });
    mocks.canMutateHive.mockResolvedValue(false);

    const res = await POST(request({ hiveId: HIVE_ID, campaignId: CAMPAIGN_ID, values: { impressions: 10 } }));

    expect(res.status).toBe(403);
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "member-1", HIVE_ID);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
