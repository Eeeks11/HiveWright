import { describe, expect, it } from "vitest";
import {
  SERVICE_PACKAGE_TEMPLATES,
  buildBusinessOsDiagnosticExport,
} from "./diagnostic-export";
import { deriveBusinessOsOwnerDashboard } from "./owner-dashboard";

function whistonDashboard() {
  return deriveBusinessOsOwnerDashboard({
    hiveId: "hive-1",
    profile: {
      id: "profile-1",
      businessMode: "existing_business",
      businessName: "Whiston Management",
      stage: "operating",
      summary: "Owner-operated property services business with inconsistent admin and revenue evidence.",
      ownerGoals: ["Make daily operations less owner-dependent", "Find the highest-leverage Business OS gaps"],
      approvalPolicy: { publicActions: "owner_approval_required", spendActions: "owner_approval_required" },
      aiSpendBudget: { capCents: 20000, window: "monthly" },
      autonomyPolicy: { posture: "supervised", externalActions: "owner_approval_required" },
    },
    setupProfile: null,
    auditProfile: {
      auditStatus: "completed",
      overallReadinessScore: 42,
      overallConfidence: "medium",
      auditScope: ["revenue", "finance_admin", "operations", "ai_governance"],
      evidenceSources: [
        { label: "Owner interview notes" },
        { label: "Internal runtime task evidence", internalUrl: "/tasks/internal-1" },
      ],
      knownUnknowns: ["No verified bookkeeping cadence supplied", "No current CRM/source-of-lead evidence supplied"],
    },
    readiness: [
      { systemKey: "finance_admin", systemLabel: "Finance/admin", readinessScore: 25, maturityLevel: "missing", confidence: "medium", evidenceRefs: [{ label: "No finance records connected" }, { label: "Internal runtime readiness evidence" }], summary: "Bookkeeping and admin cadence are not yet evidenced." },
      { systemKey: "revenue_sales", systemLabel: "Revenue / Sales", readinessScore: 35, maturityLevel: "ad_hoc", confidence: "low", evidenceRefs: [{ label: "Manual pipeline notes" }, { label: "/deliverables/internal-readiness-work-product" }], summary: "Sales follow-up exists but is not measurable." },
      { systemKey: "ai_governance", systemLabel: "AI governance", readinessScore: 70, maturityLevel: "defined", confidence: "medium", evidenceRefs: [{ label: "Owner approval policy" }], summary: "Sensitive work remains approval gated." },
    ],
    gaps: [
      { title: "Bookkeeping cadence is unknown", severity: "high", status: "open", systemKey: "finance_admin", confidence: "medium", evidenceRefs: [{ label: "audit" }] },
      { title: "Lead source and follow-up are not measurable", severity: "high", status: "open", systemKey: "revenue_sales", confidence: "low", evidenceRefs: [{ label: "pipeline notes" }] },
    ],
    recommendations: [
      { title: "Set up finance/admin baseline", rationale: "Owners cannot safely delegate work without current admin evidence.", expectedOutcome: "Weekly admin cadence exists.", riskLevel: "medium", requiresOwnerApproval: true, status: "proposed" },
      { title: "Create revenue engine measurement baseline", rationale: "Demand and conversion need one visible loop.", expectedOutcome: "Lead source, follow-up and conversion are tracked.", riskLevel: "medium", requiresOwnerApproval: true, status: "proposed" },
    ],
    actions: [
      { title: "Complete finance/admin setup checklist", brief: "Confirm bookkeeping, billing, receipt and reporting cadence.", status: "queued", priority: 95, riskLevel: "medium", approvalRequired: true, expectedOutcome: "Admin baseline is safe for delegated work.", measurementPlan: { metric: "finance_admin_checklist_completed" }, sourceRefs: [{ label: "Business OS audit" }, { label: "Internal runtime action evidence" }], systemKey: "finance_admin" },
      { title: "Map lead intake and follow-up", brief: "Record source, next step and owner-approved follow-up path.", status: "queued", priority: 86, riskLevel: "medium", approvalRequired: true, expectedOutcome: "Revenue engine has a measurable starting loop.", measurementPlan: { metric: "lead_follow_up_current" }, sourceRefs: [{ label: "Sales audit" }, { label: "/api/hives/hive-1/business-os-actions/action-1/convert" }], systemKey: "revenue_sales" },
    ],
    agentActivity: [
      { title: "Internal dogfood audit task", summary: "Generated scorecards from runtime evidence.", status: "completed", role: "hivewright-gpu", evidenceUrl: "/deliverables/internal-work-product", updatedAt: "2026-06-28T00:00:00.000Z" },
    ],
  });
}

describe("Business OS diagnostic export package", () => {
  it("builds a client-safe diagnostic with state, scores, evidence/unknowns, roadmap, and a recommended package", () => {
    const diagnostic = buildBusinessOsDiagnosticExport({
      dashboard: whistonDashboard(),
      variant: "client_safe",
      generatedAt: "2026-06-28T10:00:00.000Z",
    });

    expect(diagnostic.variant).toBe("client_safe");
    expect(diagnostic.clientSafe).toBe(true);
    expect(diagnostic.currentState).toMatchObject({
      businessName: "Whiston Management",
      mode: "existing_business",
      stage: "operating",
      overallReadinessScore: 42,
      evidenceState: "measured",
    });
    expect(diagnostic.readinessScores.map((score) => score.systemKey)).toEqual([
      "finance_admin",
      "revenue_sales",
      "ai_governance",
    ]);
    expect(diagnostic.evidenceAndUnknowns.evidence).toEqual(expect.arrayContaining([
      "Owner interview notes",
      "Business OS audit",
    ]));
    expect(diagnostic.evidenceAndUnknowns.unknowns).toEqual(expect.arrayContaining([
      "No verified bookkeeping cadence supplied",
      "No current CRM/source-of-lead evidence supplied",
    ]));
    expect(diagnostic.priorityRoadmap.next30Days[0]).toMatchObject({
      title: "Complete finance/admin setup checklist",
      systemKey: "finance_admin",
      ownerApprovalRequired: true,
    });
    expect(diagnostic.recommendedServicePackage.slug).toBe("admin-finance-setup");
    expect(diagnostic.next30_60_90.days30).toContain("Complete finance/admin setup checklist");
    expect(diagnostic.next30_60_90.days60).toEqual(expect.arrayContaining([
      "Stabilise the recommended Admin/Finance Setup package and convert the top weak system into a governed operating cadence.",
    ]));
    expect(diagnostic.next30_60_90.days90).toEqual(expect.arrayContaining([
      "Move from setup/audit into Ongoing Managed Business OS once evidence is current and approvals are operating normally.",
    ]));

    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("hivewright-gpu");
    expect(serialized).not.toContain("/deliverables/internal-work-product");
    expect(serialized).not.toContain("Internal runtime task evidence");
    expect(serialized).not.toContain("Internal runtime action evidence");
    expect(serialized).not.toContain("Internal runtime readiness evidence");
    expect(serialized).not.toContain("/api/hives/hive-1/business-os-actions/action-1/convert");
    expect(serialized).not.toContain("/deliverables/internal-readiness-work-product");
    expect(serialized).not.toContain("internalUrl");
  });

  it("keeps internal traceability in the internal variant while still offering client-safe package text", () => {
    const diagnostic = buildBusinessOsDiagnosticExport({
      dashboard: whistonDashboard(),
      variant: "internal",
      generatedAt: "2026-06-28T10:00:00.000Z",
    });

    expect(diagnostic.clientSafe).toBe(false);
    expect(diagnostic.internalTrace).toMatchObject({
      agentActivity: [
        expect.objectContaining({
          role: "hivewright-gpu",
          evidenceUrl: "/deliverables/internal-work-product",
        }),
      ],
    });
    expect(diagnostic.servicePackageTemplates.map((template) => template.slug)).toEqual([
      "audit",
      "admin-finance-setup",
      "revenue-engine-setup",
      "agent-ready-ops",
      "ongoing-managed-business-os",
    ]);
  });

  it("publishes the five reusable service package templates with clear outcomes and boundaries", () => {
    expect(SERVICE_PACKAGE_TEMPLATES).toHaveLength(5);
    expect(SERVICE_PACKAGE_TEMPLATES).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "audit", title: "Business OS Audit" }),
      expect.objectContaining({ slug: "admin-finance-setup", title: "Admin/Finance Setup" }),
      expect.objectContaining({ slug: "revenue-engine-setup", title: "Revenue Engine Setup" }),
      expect.objectContaining({ slug: "agent-ready-ops", title: "Agent-Ready Ops" }),
      expect.objectContaining({ slug: "ongoing-managed-business-os", title: "Ongoing Managed Business OS" }),
    ]));
    for (const template of SERVICE_PACKAGE_TEMPLATES) {
      expect(template.clientPromise).toBeTruthy();
      expect(template.bestFor.length).toBeGreaterThanOrEqual(1);
      expect(template.deliverables.length).toBeGreaterThanOrEqual(3);
      expect(template.boundaries).toEqual(expect.arrayContaining([
        expect.stringContaining("No autonomous public, customer-facing, spend, legal, tax, or banking action without explicit owner approval"),
      ]));
    }
  });
});
