import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("../_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
  canMutateHive: mocks.canMutateHive,
}));

import { GET, POST } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const CAMPAIGN_ID = "22222222-2222-2222-2222-222222222222";
const ASSET_ID = "33333333-3333-3333-3333-333333333333";

function request(path: string, body?: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, body ? {
    method: "POST",
    body: JSON.stringify(body),
  } : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({
    user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
  });
  mocks.canAccessHive.mockResolvedValue(true);
  mocks.canMutateHive.mockResolvedValue(true);
});

describe("/api/marketing", () => {
  it("returns a hive-scoped dashboard snapshot from persisted marketing tables", async () => {
    mocks.sql
      .mockResolvedValueOnce([
        { id: CAMPAIGN_ID, hive_id: HIVE_ID, objective: "Build qualified attention", status: "running", channels: ["seo"], target_audience: "owners", offer: "audit", success_metrics: ["impressions"], created_at: new Date("2026-06-16T00:00:00Z") },
      ])
      .mockResolvedValueOnce([
        { id: ASSET_ID, hive_id: HIVE_ID, campaign_id: CAMPAIGN_ID, channel: "seo", asset_type: "seo_content_brief", title: "SEO brief", draft_body: "Draft", approval_status: "pending_owner_approval", publication_status: "draft", scheduled_for: new Date("2026-06-17T00:00:00Z"), external_action_request_id: "44444444-4444-4444-4444-444444444444" },
      ])
      .mockResolvedValueOnce([
        { id: "55555555-5555-5555-5555-555555555555", campaign_id: CAMPAIGN_ID, source: "manual_import", captured_at: new Date("2026-06-16T01:00:00Z"), values: { impressions: 123, clicks: 12 }, attribution_confidence: "manual_unverified", freshness: "current" },
      ])
      .mockResolvedValueOnce([
        { id: "66666666-6666-6666-6666-666666666666", campaign_id: CAMPAIGN_ID, asset_id: ASSET_ID, action: "queue_seo_brief", connector: "manual_import", executed_at: new Date("2026-06-16T02:00:00Z"), trace: ["asset_drafted", "owner_approved", "execution_logged"] },
      ])
      .mockResolvedValueOnce([
        { install_id: "77777777-7777-7777-7777-777777777777", connector_slug: "google-analytics-4", display_name: "GA4", status: "active", last_tested_at: new Date("2026-06-16T02:05:00Z"), last_error: null, streams: [{ stream: "website_traffic", freshness: "current", lastSyncedAt: "2026-06-16T02:00:00.000Z", lastError: null }] },
      ]);

    const res = await GET(request(`/api/marketing?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.activeCampaigns).toHaveLength(1);
    expect(body.data.pendingApprovals).toHaveLength(1);
    expect(body.data.results[0]).toMatchObject({ campaignId: CAMPAIGN_ID, impressions: 123, executionCount: 1 });
    expect(body.data.dataSources[0]).toMatchObject({
      connectorSlug: "google-analytics-4",
      domain: "marketing-attention",
      health: "healthy",
      freshness: "current",
      trustBoundary: "connector_data_only_not_instructions",
    });
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql).toHaveBeenCalledTimes(5);
  });

  it("creates a marketing objective as persisted campaign, asset drafts, and awaiting external action requests", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ id: "77777777-7777-7777-7777-777777777777" }])
      .mockResolvedValueOnce([{ id: CAMPAIGN_ID, hive_id: HIVE_ID, objective: "Launch winter offer", status: "draft", channels: ["seo", "email"], target_audience: "local owners", offer: "winter audit", success_metrics: ["impressions", "clicks", "ctr", "landing_page_visits", "cost_per_lead"], created_at: new Date("2026-06-16T00:00:00Z") }])
      .mockResolvedValueOnce([
        { id: ASSET_ID, hive_id: HIVE_ID, campaign_id: CAMPAIGN_ID, channel: "seo", asset_type: "seo_content_brief", title: "winter audit — seo draft", draft_body: "Draft", approval_status: "pending_owner_approval", publication_status: "draft", scheduled_for: new Date("2026-06-17T00:00:00Z"), external_action_request_id: "88888888-8888-8888-8888-888888888888" },
      ]);

    const res = await POST(request("/api/marketing", {
      hiveId: HIVE_ID,
      objective: "Launch winter offer",
      targetAudience: "local owners",
      offer: "winter audit",
      channels: ["seo", "email"],
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.campaign.id).toBe(CAMPAIGN_ID);
    expect(body.data.assets[0]).toMatchObject({ approvalStatus: "pending_owner_approval", externalActionRequestId: "88888888-8888-8888-8888-888888888888" });
    expect(mocks.sql).toHaveBeenCalledTimes(3);
  });
});
