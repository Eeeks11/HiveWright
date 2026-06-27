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

  it("builds the ideal operating model map with Marketing and Sales linked as Business OS modules", () => {
    const dashboard = deriveBusinessOsOwnerDashboard({
      profile: {
        id: "profile-1",
        businessMode: "existing_business",
        businessName: "Whiston Management",
        stage: "operating",
        summary: "Existing business audit.",
        ownerGoals: ["Run the business through one map"],
        approvalPolicy: {},
        aiSpendBudget: { capCents: 10000, window: "monthly" },
        autonomyPolicy: {},
      },
      setupProfile: null,
      auditProfile: null,
      readiness: [
        { systemKey: "revenue_marketing", systemLabel: "Revenue / Marketing", readinessScore: 55, maturityLevel: "defined", confidence: "medium", evidenceRefs: [{ label: "Campaign metrics" }], summary: "Marketing cadence exists.", updatedAt: "2026-06-24T03:00:00.000Z" },
        { systemKey: "revenue_sales", systemLabel: "Revenue / Sales", readinessScore: 30, maturityLevel: "ad_hoc", confidence: "low", evidenceRefs: [], summary: "Sales funnel has leaks.", updatedAt: "2026-06-24T04:00:00.000Z" },
      ],
      gaps: [
        { title: "Sales follow-up is inconsistent", severity: "high", status: "open", systemKey: "revenue_sales", confidence: "medium", evidenceRefs: [{ label: "sales audit" }] },
      ],
      recommendations: [],
      actions: [
        { title: "Fix sales follow-up cadence", brief: "Create one owner-approved conversion fix.", status: "queued", priority: 80, riskLevel: "medium", approvalRequired: true, expectedOutcome: "Sales leak is measurable.", measurementPlan: { metric: "lead_response_time" }, sourceRefs: [{ label: "sales plan" }], systemKey: "revenue_sales", createdAt: "2026-06-24T05:00:00.000Z" },
      ],
      agentActivity: [],
      moduleSnapshots: [
        {
          key: "revenue_marketing",
          href: "/marketing?hiveId=hive-1",
          summary: "2 campaigns, 1 current metric snapshot.",
          connectedSystems: ["Google Analytics 4"],
          evidenceRefs: [{ label: "Marketing dashboard" }],
          nextReviewAt: "2026-07-01T00:00:00.000Z",
        },
        {
          key: "revenue_sales",
          href: "/sales?hiveId=hive-1",
          summary: "1 funnel and 1 action plan.",
          connectedSystems: ["CRM"],
          evidenceRefs: [{ label: "Sales dashboard" }],
          nextReviewAt: "2026-06-30T00:00:00.000Z",
        },
      ],
    });

    expect(dashboard.operatingModelMap.modules.map((module) => module.key)).toEqual([
      "foundation",
      "revenue_marketing",
      "revenue_sales",
      "ops_delivery",
      "finance_admin",
      "people_sops",
      "customer_success_reviews",
      "compliance_risk",
      "software_integrations_data",
      "ai_governance",
    ]);
    expect(dashboard.operatingModelMap.overallScore).toBe(9);
    expect(dashboard.operatingModelMap.nextReviewAt).toBe("2026-06-30T00:00:00.000Z");
    expect(dashboard.operatingModelMap.modules.find((module) => module.key === "revenue_marketing")).toMatchObject({
      label: "Revenue / Marketing",
      href: "/marketing?hiveId=hive-1",
      score: 55,
      maturity: "defined",
      evidenceState: "measured",
      connectedSystems: ["Google Analytics 4"],
    });
    expect(dashboard.operatingModelMap.modules.find((module) => module.key === "revenue_sales")).toMatchObject({
      href: "/sales?hiveId=hive-1",
      score: 30,
      maturity: "ad_hoc",
      evidenceState: "partial",
      gaps: ["Sales follow-up is inconsistent"],
      actions: ["Fix sales follow-up cadence"],
      connectedSystems: ["CRM"],
    });
    expect(dashboard.operatingModelMap.modules.find((module) => module.key === "ai_governance")).toMatchObject({
      evidenceState: "missing",
      score: null,
      gaps: [],
      actions: [],
      connectedSystems: [],
    });
  });

  it("counts missing operating-model modules against the owner-facing overall score", () => {
    const dashboard = deriveBusinessOsOwnerDashboard({
      profile: {
        id: "profile-1",
        businessMode: "existing_business",
        businessName: "Whiston Management",
        stage: "operating",
        summary: "Only one system has been measured.",
        ownerGoals: ["Expose underbuilt systems quickly"],
        approvalPolicy: {},
        aiSpendBudget: {},
        autonomyPolicy: {},
      },
      setupProfile: null,
      auditProfile: null,
      readiness: [
        { systemKey: "ai_governance", systemLabel: "AI governance", readinessScore: 100, maturityLevel: "managed", confidence: "high", evidenceRefs: [{ label: "approval policy" }], summary: "Governance is measured." },
      ],
      gaps: [],
      recommendations: [],
      actions: [],
      agentActivity: [],
    });

    expect(dashboard.operatingModelMap.overallScore).toBe(10);
    expect(dashboard.operatingModelMap.modules.filter((module) => module.evidenceState === "missing")).toHaveLength(9);
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

  it("exposes a conversion contract for active Business OS actions", () => {
    const dashboard = deriveBusinessOsOwnerDashboard({
      hiveId: "hive-1",
      profile: {
        id: "profile-1",
        businessMode: "existing_business",
        businessName: "Whiston Management",
        stage: "operating",
        summary: "Existing business audit.",
        ownerGoals: ["Convert weak systems into owned action"],
        approvalPolicy: {},
        aiSpendBudget: {},
        autonomyPolicy: {},
      },
      setupProfile: null,
      auditProfile: null,
      readiness: [],
      gaps: [],
      recommendations: [],
      actions: [{
        id: "action-1",
        title: "Fix finance evidence cadence",
        brief: "Turn the finance/admin gap into scheduled owner-visible work.",
        status: "queued",
        priority: 80,
        riskLevel: "medium",
        approvalRequired: true,
        expectedOutcome: "Weekly finance evidence is current.",
        measurementPlan: { metric: "finance_evidence_current", target: "weekly records reviewed" },
        sourceRefs: [{ label: "audit gap" }],
      }],
      agentActivity: [],
    });

    expect(dashboard.priorityActions[0]).toMatchObject({
      title: "Fix finance evidence cadence",
      conversionAffordance: {
        label: "Convert to governed work",
        href: "/api/hives/hive-1/business-os-actions/action-1/convert",
        options: ["request_owner_approval"],
        contract: {
          expectedOutcome: "Weekly finance evidence is current.",
          measurementMetric: "finance_evidence_current",
          ownerApprovalRequired: true,
        },
      },
    });
  });

  it("only advertises convert-route supported options for approved approval-required actions", () => {
    const dashboard = deriveBusinessOsOwnerDashboard({
      hiveId: "hive-1",
      profile: {
        id: "profile-1",
        businessMode: "existing_business",
        businessName: "Whiston Management",
        stage: "operating",
        summary: "Existing business audit.",
        ownerGoals: ["Convert approved sensitive work safely"],
        approvalPolicy: {},
        aiSpendBudget: {},
        autonomyPolicy: {},
      },
      setupProfile: null,
      auditProfile: null,
      readiness: [],
      gaps: [],
      recommendations: [],
      actions: [{
        id: "action-1",
        title: "Fix finance evidence cadence",
        brief: "Owner has approved this sensitive action for governed execution.",
        status: "approved",
        priority: 80,
        riskLevel: "medium",
        approvalRequired: true,
        expectedOutcome: "Weekly finance evidence is current.",
        measurementPlan: { metric: "finance_evidence_current", target: "weekly records reviewed" },
        sourceRefs: [{ label: "audit gap" }],
      }],
      agentActivity: [],
    });

    expect(dashboard.priorityActions[0].conversionAffordance.options).toEqual([
      "create_agent_task",
      "create_schedule",
      "create_sop_draft",
    ]);
  });

});
