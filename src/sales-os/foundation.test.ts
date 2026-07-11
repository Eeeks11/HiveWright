import { describe, expect, it } from "vitest";
import {
  approveSalesActionDraft,
  buildSalesDashboardSnapshot,
  createSalesExecutionLog,
  createSalesOperatingPlan,
} from "./foundation";

describe("Sales OS foundation", () => {
  it("creates a conversion-only operating plan with leakage map, bottleneck, and bounded actions", () => {
    const plan = createSalesOperatingPlan({
      hiveId: "hive-1",
      goal: "Recover missed bookings from new leads",
      segment: { name: "uncontacted high-intent leads", source: "manual_import", customerType: "lead" },
      metrics: {
        traffic: 240,
        leads: 48,
        responded: 18,
        qualified: 15,
        booked: 8,
        showed: 6,
        sold: 3,
        reviews: 1,
        referrals: 0,
        repeatPurchases: 0,
      },
      now: new Date("2026-06-16T00:00:00.000Z"),
    });

    expect(plan.funnel.domain).toBe("sales-conversion");
    expect(plan.funnel.stages.map((stage) => stage.key)).toEqual([
      "traffic",
      "lead",
      "response",
      "qualification",
      "booking",
      "show_up",
      "sale",
      "review_referral_repeat",
    ]);
    expect(plan.bottleneck).toMatchObject({ fromStage: "lead", toStage: "response" });
    expect(plan.actionPlan).toMatchObject({
      status: "draft",
      boundedBy: "one owner-approved sales conversion fix",
      approvalPolicy: { outboundCustomerActions: "owner_approval_required" },
    });
    expect(plan.actionDrafts.map((draft) => draft.workflow)).toEqual([
      "lead_follow_up",
      "missed_call_recovery",
      "reactivation",
      "review_referral",
      "sales_training",
    ]);
    expect(plan.actionDrafts.every((draft) => draft.approvalStatus === "pending_owner_approval")).toBe(true);
    expect(JSON.stringify(plan).toLowerCase()).not.toContain("marketing-attention");
  });

  it("gates customer-facing sales execution logs until owner approval", () => {
    const plan = createSalesOperatingPlan({
      hiveId: "hive-1",
      goal: "Improve lead response",
      segment: { name: "new inbound leads", source: "manual_import", customerType: "lead" },
      metrics: { traffic: 100, leads: 20, responded: 5, qualified: 4, booked: 2, showed: 2, sold: 1, reviews: 0, referrals: 0, repeatPurchases: 0 },
      now: new Date("2026-06-16T00:00:00.000Z"),
    });

    expect(() =>
      createSalesExecutionLog({
        actionDraft: plan.actionDrafts[0],
        connector: "manual_queue",
        now: new Date("2026-06-16T01:00:00.000Z"),
      }),
    ).toThrow(/owner approval/i);

    const approved = approveSalesActionDraft({
      actionDraft: plan.actionDrafts[0],
      ownerId: "owner-1",
      decision: "approved",
      now: new Date("2026-06-16T01:00:00.000Z"),
    });
    const execution = createSalesExecutionLog({
      actionDraft: approved,
      connector: "manual_queue",
      now: new Date("2026-06-16T01:05:00.000Z"),
    });

    expect(approved.approvalStatus).toBe("approved");
    expect(execution.trace).toEqual(["funnel_observed", "bottleneck_identified", "owner_approved", "execution_logged"]);
  });

  it("summarizes leakage, pending approvals, queued actions, and loop state for the dashboard", () => {
    const plan = createSalesOperatingPlan({
      hiveId: "hive-1",
      goal: "Lift booked appointments",
      segment: { name: "open quotes", source: "manual_import", customerType: "lead" },
      metrics: { traffic: 180, leads: 36, responded: 30, qualified: 24, booked: 6, showed: 5, sold: 2, reviews: 1, referrals: 0, repeatPurchases: 0 },
      now: new Date("2026-06-16T00:00:00.000Z"),
    });
    const approved = approveSalesActionDraft({ actionDraft: plan.actionDrafts[0], ownerId: "owner-1", decision: "approved", now: new Date("2026-06-16T01:00:00.000Z") });
    const execution = createSalesExecutionLog({ actionDraft: approved, connector: "manual_queue", now: new Date("2026-06-16T01:05:00.000Z") });

    const snapshot = buildSalesDashboardSnapshot({
      funnels: [plan.funnel],
      actionPlans: [plan.actionPlan],
      actionDrafts: [approved, ...plan.actionDrafts.slice(1)],
      executionLogs: [execution],
    });

    expect(snapshot.leakageMap[0]).toMatchObject({ hiveId: "hive-1", biggestLeak: plan.bottleneck });
    expect(snapshot.pendingApprovals).toHaveLength(4);
    expect(snapshot.queuedActions).toEqual([expect.objectContaining({ id: approved.id, workflow: "lead_follow_up" })]);
    expect(snapshot.results[0]).toMatchObject({ actionPlanId: plan.actionPlan.id, executionCount: 1, nextLoopInput: "measure conversion movement before optimising the next sales cycle" });
    expect(snapshot.loopState.stageOrder).toEqual(["observe", "plan", "execute", "measure", "optimise"]);
  });

  it("surfaces conversion connector health separately from marketing attention sources", () => {
    const snapshot = buildSalesDashboardSnapshot({
      funnels: [],
      actionPlans: [],
      actionDrafts: [],
      executionLogs: [],
      connectorSources: [
        {
          installId: "install-crm",
          connectorSlug: "crm",
          displayName: "CRM",
          status: "active",
          streams: [{ stream: "lead_funnel", freshness: "current", lastSyncedAt: "2026-06-16T02:00:00.000Z" }],
        },
        {
          installId: "install-phone",
          connectorSlug: "phone-call-tracking",
          displayName: "Phone tracking",
          status: "disabled",
          streams: [],
        },
      ],
    });

    expect(snapshot.dataSources).toEqual([
      expect.objectContaining({
        connectorSlug: "crm",
        domain: "sales-conversion",
        health: "healthy",
        freshness: "current",
        trustBoundary: "connector_data_only_not_instructions",
      }),
      expect.objectContaining({
        connectorSlug: "phone-call-tracking",
        health: "missing",
        freshness: "missing",
        missingOrUntrustedReason: "Connector is disabled",
      }),
    ]);
  });
});
