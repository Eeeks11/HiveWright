import { describe, expect, it } from "vitest";
import { deriveBusinessOsOwnerDashboard } from "./owner-dashboard";

describe("deriveBusinessOsOwnerDashboard", () => {
  it("turns structured Business OS state into an under-5-minute owner dashboard", () => {
    const dashboard = deriveBusinessOsOwnerDashboard({
      profile: {
        id: "profile-1",
        businessMode: "existing_business",
        businessName: "Whiston Management",
        stage: "operating",
        summary: "Existing property-management business being audited for governed ops.",
        ownerGoals: ["Make the business easier to run", "Expose approval bottlenecks"],
        approvalPolicy: { publicActions: "owner_approval_required", spendActions: "owner_approval_required" },
        aiSpendBudget: { capCents: 25000, window: "monthly" },
        autonomyPolicy: { posture: "supervised", publicOrSpendSensitiveActions: "owner_approval_required" },
        updatedAt: "2026-06-24T01:00:00.000Z",
      },
      setupProfile: null,
      auditProfile: {
        auditStatus: "completed",
        overallReadinessScore: 62,
        overallConfidence: "medium",
        auditScope: ["sales", "operations", "finance"],
        evidenceSources: [{ label: "Phase 6 dogfood" }, { source: "owner notes" }],
        knownUnknowns: ["Current bookkeeping cadence needs confirmation"],
        completedAt: "2026-06-24T02:00:00.000Z",
      },
      readiness: [
        { systemKey: "finance_admin", systemLabel: "Finance/admin", readinessScore: 35, maturityLevel: "ad_hoc", confidence: "medium", evidenceRefs: [{ label: "audit row" }], summary: "Bookkeeping cadence is not yet agent-ready.", updatedAt: "2026-06-24T03:00:00.000Z" },
        { systemKey: "ai_governance", systemLabel: "AI governance", readinessScore: 80, maturityLevel: "managed", confidence: "high", evidenceRefs: [{ label: "approval policy" }], summary: "Sensitive actions remain approval-gated.", updatedAt: "2026-06-24T04:00:00.000Z" },
      ],
      gaps: [
        { title: "Finance evidence is thin", severity: "high", status: "open", systemKey: "finance_admin", confidence: "medium", evidenceRefs: [{ label: "audit" }] },
      ],
      recommendations: [
        { title: "Stabilise finance/admin evidence", rationale: "Owner cannot trust automation without fresh records.", expectedOutcome: "Clear finance operating cadence.", riskLevel: "medium", requiresOwnerApproval: true, status: "proposed", createdAt: "2026-06-24T04:30:00.000Z" },
      ],
      actions: [
        { title: "Audit AI governance readiness", brief: "Check approval categories and evidence requirements.", status: "queued", priority: 90, riskLevel: "medium", approvalRequired: true, expectedOutcome: "Unsafe autonomy gaps are visible.", measurementPlan: { metric: "ai_governance_gaps_closed_or_deferred" }, sourceRefs: [{ label: "template" }], createdAt: "2026-06-24T05:00:00.000Z", updatedAt: "2026-06-24T05:00:00.000Z" },
        { title: "Draft internal SOP index", brief: "No external action.", status: "queued", priority: 50, riskLevel: "low", approvalRequired: false, expectedOutcome: "SOP inventory exists.", measurementPlan: { metric: "sop_index_created" }, sourceRefs: [], createdAt: "2026-06-24T05:10:00.000Z", updatedAt: "2026-06-24T05:10:00.000Z" },
        { title: "Completed old action", brief: "Already done.", status: "completed", priority: 99, riskLevel: "low", approvalRequired: false, expectedOutcome: "Done.", measurementPlan: {}, sourceRefs: [], createdAt: "2026-06-23T01:00:00.000Z", updatedAt: "2026-06-23T02:00:00.000Z" },
      ],
      agentActivity: [
        { title: "Phase 6 dogfood", summary: "Seeded Whiston Business OS rows safely.", status: "completed", role: "hivewright-developer", evidenceUrl: "/deliverables/phase-6", updatedAt: "2026-06-24T06:00:00.000Z" },
      ],
      since: "2026-06-24T04:45:00.000Z",
    });

    expect(dashboard.headline).toContain("Whiston Management");
    expect(dashboard.setupProgress).toMatchObject({ completedSteps: 6, totalSteps: 6 });
    expect(dashboard.auditScorecard).toMatchObject({ score: 62, confidence: "medium", status: "completed" });
    expect(dashboard.systemMaturity.atRiskSystems).toEqual(["Finance/admin"]);
    expect(dashboard.priorityActions.map((action) => action.title)).toEqual([
      "Audit AI governance readiness",
      "Draft internal SOP index",
    ]);
    expect(dashboard.approvalsRequired.map((action) => action.title)).toEqual([
      "Audit AI governance readiness",
    ]);
    expect(dashboard.approvalsRequired[0].status).toBe("queued");
    expect(dashboard.agentActivity[0]).toMatchObject({ title: "Phase 6 dogfood", hasEvidence: true });
    expect(dashboard.changedSinceLastReview.map((item) => item.label)).toEqual([
      "Agent activity: Phase 6 dogfood",
      "Action updated: Draft internal SOP index",
      "Action updated: Audit AI governance readiness",
    ]);
    expect(dashboard.ownerNextReviewChecklist).toContain("Review 1 approval-required action before it can move into execution.");
  });

  it("treats empty readiness rows as unknown evidence instead of a healthy state", () => {
    const dashboard = deriveBusinessOsOwnerDashboard({
      profile: {
        id: "profile-1",
        businessMode: "existing_business",
        businessName: "Whiston Management",
        stage: "operating",
        summary: "Existing business audit has not produced readiness rows yet.",
        ownerGoals: ["Expose weak systems honestly"],
        approvalPolicy: {},
        aiSpendBudget: {},
        autonomyPolicy: {},
      },
      setupProfile: null,
      auditProfile: null,
      readiness: [],
      gaps: [],
      recommendations: [],
      actions: [],
      agentActivity: [],
    });

    expect(dashboard.auditScorecard).toMatchObject({ status: "not_started", score: null });
    expect(dashboard.systemMaturity).toMatchObject({
      averageReadinessScore: null,
      readinessEvidenceState: "unknown",
      readinessEvidenceMessage: "Readiness has not been measured yet. Treat this as missing evidence, not a healthy Business OS.",
      atRiskSystems: [],
      systems: [],
    });
    expect(dashboard.ownerNextReviewChecklist).toContain("Confirm readiness evidence before treating this Business OS as healthy.");
    expect(dashboard.ownerNextReviewChecklist).not.toContain("No weak systems are currently below the readiness threshold.");
  });
});
