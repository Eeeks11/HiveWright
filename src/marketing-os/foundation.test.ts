import { describe, expect, it } from "vitest";
import {
  approveMarketingAsset,
  approveMarketingBudgetChange,
  buildMarketingDashboardSnapshot,
  createMarketingExecutionLog,
  createMarketingObjectiveDraft,
  createMarketingProfile,
  evaluatePaidCampaignPolicy,
  startPaidMarketingCampaign,
} from "./foundation";

describe("Marketing OS foundation", () => {
  it("creates a marketing profile and objective draft without sales-conversion leakage", () => {
    const profile = createMarketingProfile({
      hiveId: "hive-1",
      industry: "local trades",
      targetCustomers: ["home owners needing urgent repairs"],
      offers: ["same-day quote"],
      serviceAreas: ["Melbourne"],
      brandVoice: "plain-spoken expert",
      forbiddenClaims: ["guaranteed #1 ranking"],
    });

    const draft = createMarketingObjectiveDraft({
      hiveId: "hive-1",
      objective: "Generate qualified website attention for winter roof repairs",
      targetAudience: "Melbourne home owners",
      offer: "free inspection call",
      channels: ["seo", "google_business_profile", "email"],
      now: new Date("2026-06-16T00:00:00.000Z"),
    });

    expect(profile.approvalPolicy.publicOrSpendActions).toBe("owner_approval_required");
    expect(draft.campaign.domain).toBe("marketing-attention");
    expect(draft.campaign.objective).toContain("qualified website attention");
    expect(draft.campaign.status).toBe("draft");
    expect(draft.campaign.successMetrics).toEqual(["impressions", "clicks", "ctr", "landing_page_visits", "cost_per_lead"]);
    expect(draft.assets).toHaveLength(3);
    expect(draft.assets.every((asset) => asset.approvalStatus === "pending_owner_approval")).toBe(true);
    expect(draft.assets.every((asset) => asset.publicationStatus === "draft")).toBe(true);
    expect(draft.contentCalendar).toHaveLength(3);
    expect(JSON.stringify(draft).toLowerCase()).not.toContain("sales-conversion");
  });

  it("gates execution logs until the owner approves the asset", () => {
    const { assets } = createMarketingObjectiveDraft({
      hiveId: "hive-1",
      objective: "Build attention for a June offer",
      targetAudience: "existing subscribers",
      offer: "June tune-up",
      channels: ["email"],
      now: new Date("2026-06-16T00:00:00.000Z"),
    });

    expect(() =>
      createMarketingExecutionLog({
        asset: assets[0],
        action: "publish_email_draft",
        connector: "manual",
        now: new Date("2026-06-16T01:00:00.000Z"),
      }),
    ).toThrow(/owner approval/i);

    const approved = approveMarketingAsset({
      asset: assets[0],
      decision: "approved",
      ownerId: "owner-1",
      reason: "Matches offer and brand voice",
      now: new Date("2026-06-16T01:00:00.000Z"),
    });

    const log = createMarketingExecutionLog({
      asset: approved,
      action: "queue_email_campaign",
      connector: "manual_import",
      now: new Date("2026-06-16T01:05:00.000Z"),
    });

    expect(approved.approvalStatus).toBe("approved");
    expect(log.assetId).toBe(approved.id);
    expect(log.trace).toEqual([
      "asset_drafted",
      "owner_approved",
      "execution_logged",
    ]);
  });

  it("summarizes active campaigns, pending approvals, manual metrics, and executed results for the dashboard", () => {
    const draft = createMarketingObjectiveDraft({
      hiveId: "hive-1",
      objective: "Increase Google Business attention",
      targetAudience: "nearby high-intent searchers",
      offer: "emergency callout",
      channels: ["google_business_profile", "seo"],
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    const approved = approveMarketingAsset({
      asset: draft.assets[0],
      decision: "approved",
      ownerId: "owner-1",
      now: new Date("2026-06-16T01:00:00.000Z"),
    });
    const execution = createMarketingExecutionLog({
      asset: approved,
      action: "publish_google_business_profile_update",
      connector: "manual_import",
      now: new Date("2026-06-16T01:05:00.000Z"),
    });

    const snapshot = buildMarketingDashboardSnapshot({
      campaigns: [{ ...draft.campaign, status: "running" }],
      assets: [approved, draft.assets[1]],
      metrics: [
        {
          id: "metric-1",
          campaignId: draft.campaign.id,
          source: "manual_import",
          capturedAt: "2026-06-16T02:00:00.000Z",
          values: { impressions: 1200, clicks: 84, ctr: 0.07, landing_page_visits: 52 },
          attributionConfidence: "manual_unverified",
          freshness: "current",
        },
      ],
      executionLogs: [execution],
    });

    expect(snapshot.activeCampaigns).toEqual([
      expect.objectContaining({ id: draft.campaign.id, status: "running" }),
    ]);
    expect(snapshot.pendingApprovals).toEqual([
      expect.objectContaining({ id: draft.assets[1].id, approvalStatus: "pending_owner_approval" }),
    ]);
    expect(snapshot.results).toEqual([
      expect.objectContaining({ campaignId: draft.campaign.id, impressions: 1200, clicks: 84, executionCount: 1 }),
    ]);
    expect(snapshot.contentCalendar).toEqual([
      expect.objectContaining({ assetId: approved.id, status: "queued", scheduledFor: approved.scheduledFor }),
      expect.objectContaining({ assetId: draft.assets[1].id, status: "draft", scheduledFor: draft.assets[1].scheduledFor }),
    ]);
    expect(snapshot.loopState.stageOrder).toEqual(["observe", "plan", "execute", "measure", "optimise"]);
  });

  it("blocks paid ads from starting without an explicit approved spend cap", () => {
    const draft = createMarketingObjectiveDraft({
      hiveId: "hive-1",
      objective: "Launch a winter retargeting ad",
      targetAudience: "recent website visitors",
      offer: "book a winter stay",
      channels: ["ads"],
      now: new Date("2026-06-16T00:00:00.000Z"),
    });

    expect(() => startPaidMarketingCampaign({ campaign: draft.campaign })).toThrow(/budget cap/i);

    const budgetApproval = approveMarketingBudgetChange({
      campaign: draft.campaign,
      requestedBudgetCents: 50000,
      ownerId: "owner-1",
      reason: "Owner approved a capped retargeting test",
      now: new Date("2026-06-16T01:00:00.000Z"),
    });

    const running = startPaidMarketingCampaign({ campaign: budgetApproval.campaign, budgetApproval: budgetApproval.budgetApproval });

    expect(budgetApproval.approvalStatus).toBe("approved");
    expect(running.status).toBe("running");
    expect(running.spendBudgetCents).toBe(50000);
  });

  it("pauses paid campaigns when spend policy detects bad CPL or weak downstream conversion", () => {
    const draft = createMarketingObjectiveDraft({
      hiveId: "hive-1",
      objective: "Scale paid search attention",
      targetAudience: "high-intent searchers",
      offer: "quote request",
      channels: ["ads"],
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    const budgetApproval = approveMarketingBudgetChange({ campaign: draft.campaign, requestedBudgetCents: 100000, ownerId: "owner-1" });
    const running = startPaidMarketingCampaign({ campaign: budgetApproval.campaign, budgetApproval: budgetApproval.budgetApproval });

    const policy = evaluatePaidCampaignPolicy({
      campaign: running,
      metric: {
        id: "metric-ads-1",
        campaignId: running.id,
        source: "connector",
        capturedAt: "2026-06-16T02:00:00.000Z",
        values: { ad_spend_cents: 75000, clicks: 100, leads: 3, qualified_leads: 0, bookings: 0, sales: 0 },
        attributionConfidence: "connector_verified",
        freshness: "current",
      },
      maxCostPerLeadCents: 15000,
      minLeadQualityRate: 0.25,
      minLeadToBookingRate: 0.1,
    });

    expect(policy.recommendedStatus).toBe("paused");
    expect(policy.rule).toBe("pause");
    expect(policy.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/cost per lead/i), expect.stringMatching(/lead quality/i)]));
  });

  it("shows paid ad spend, CPL, lead quality, and downstream conversion in marketing dashboard results", () => {
    const draft = createMarketingObjectiveDraft({
      hiveId: "hive-1",
      objective: "Measure paid ads downstream conversion",
      targetAudience: "retargeting audience",
      offer: "book direct",
      channels: ["ads"],
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    const budgetApproval = approveMarketingBudgetChange({ campaign: draft.campaign, requestedBudgetCents: 100000, ownerId: "owner-1" });
    const running = startPaidMarketingCampaign({ campaign: budgetApproval.campaign, budgetApproval: budgetApproval.budgetApproval });

    const snapshot = buildMarketingDashboardSnapshot({
      campaigns: [running],
      assets: draft.assets,
      metrics: [{
        id: "metric-ads-2",
        campaignId: running.id,
        source: "connector",
        capturedAt: "2026-06-16T02:00:00.000Z",
        values: { ad_spend_cents: 30000, clicks: 120, leads: 12, qualified_leads: 6, bookings: 3, sales: 1 },
        attributionConfidence: "connector_verified",
        freshness: "current",
      }],
      executionLogs: [],
    });

    expect(snapshot.results).toEqual([
      expect.objectContaining({
        campaignId: running.id,
        spendBudgetCents: 100000,
        adSpendCents: 30000,
        costPerLeadCents: 2500,
        leadQualityRate: 0.5,
        leadToBookingRate: 0.25,
        downstreamConversion: expect.objectContaining({ leads: 12, bookings: 3, sales: 1 }),
      }),
    ]);
  });

  it("surfaces connector health and data trust boundaries without treating external content as instructions", () => {
    const snapshot = buildMarketingDashboardSnapshot({
      campaigns: [],
      assets: [],
      metrics: [],
      executionLogs: [],
      connectorSources: [
        {
          installId: "install-ga4",
          connectorSlug: "google-analytics-4",
          displayName: "GA4",
          status: "active",
          streams: [
            { stream: "website_traffic", freshness: "current", lastSyncedAt: "2026-06-16T02:00:00.000Z" },
          ],
        },
        {
          installId: "install-gbp",
          connectorSlug: "google-business-profile",
          displayName: "Google Business Profile",
          status: "broken",
          lastError: "OAuth token expired",
          streams: [
            { stream: "reviews", freshness: "stale", lastSyncedAt: "2026-06-15T00:00:00.000Z", lastError: "OAuth token expired" },
          ],
        },
      ],
    });

    expect(snapshot.dataSources).toEqual([
      expect.objectContaining({
        connectorSlug: "google-analytics-4",
        domain: "marketing-attention",
        health: "healthy",
        freshness: "current",
        trustBoundary: "connector_data_only_not_instructions",
      }),
      expect.objectContaining({
        connectorSlug: "google-business-profile",
        health: "broken",
        freshness: "stale",
        missingOrUntrustedReason: "OAuth token expired",
      }),
    ]);
  });
});
