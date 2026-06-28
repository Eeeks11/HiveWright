import type { BusinessOsOwnerDashboard } from "./owner-dashboard";

export type DiagnosticVariant = "internal" | "client_safe";

export type ServicePackageTemplate = {
  slug: "audit" | "admin-finance-setup" | "revenue-engine-setup" | "agent-ready-ops" | "ongoing-managed-business-os";
  title: string;
  clientPromise: string;
  bestFor: string[];
  deliverables: string[];
  boundaries: string[];
};

type Dashboard = BusinessOsOwnerDashboard;
type DashboardAction = Dashboard["priorityActions"][number];
type DashboardSystem = Dashboard["systemMaturity"]["systems"][number];

const OWNER_APPROVAL_BOUNDARY = "No autonomous public, customer-facing, spend, legal, tax, or banking action without explicit owner approval.";

export const SERVICE_PACKAGE_TEMPLATES: ServicePackageTemplate[] = [
  {
    slug: "audit",
    title: "Business OS Audit",
    clientPromise: "A clear diagnostic of the current operating model, weak systems, evidence gaps, and the safest next package.",
    bestFor: ["Existing businesses that need a current-state map before setup or managed operations."],
    deliverables: [
      "Business OS current-state scorecard",
      "Evidence and unknowns register",
      "Prioritised 30/60/90 roadmap",
      "Recommended next service package",
    ],
    boundaries: [OWNER_APPROVAL_BOUNDARY, "Diagnostic only: no customer, finance, legal, tax, or software changes are executed during the audit."],
  },
  {
    slug: "admin-finance-setup",
    title: "Admin/Finance Setup",
    clientPromise: "Make bookkeeping, billing, reporting, receipts, and admin cadence visible enough for governed delegation.",
    bestFor: ["Businesses with weak finance/admin evidence, stale reporting, or owner-memory admin processes."],
    deliverables: [
      "Admin and finance baseline checklist",
      "Bookkeeping/reporting cadence map",
      "Billing, receipts, and reconciliation evidence plan",
      "Owner approval boundaries for financial actions",
    ],
    boundaries: [OWNER_APPROVAL_BOUNDARY, "Not legal, tax, accounting, or financial advice; professional review remains the owner's responsibility."],
  },
  {
    slug: "revenue-engine-setup",
    title: "Revenue Engine Setup",
    clientPromise: "Turn demand, leads, follow-up, offers, and conversion into one measurable owner-approved revenue loop.",
    bestFor: ["Businesses where marketing, lead intake, sales follow-up, or conversion evidence is inconsistent."],
    deliverables: [
      "Lead source and funnel baseline",
      "Offer/conversion measurement plan",
      "Owner-approved follow-up workflow",
      "First governed revenue improvement action",
    ],
    boundaries: [OWNER_APPROVAL_BOUNDARY, "No public campaigns, ads, customer outreach, discounts, or spend are launched without owner approval."],
  },
  {
    slug: "agent-ready-ops",
    title: "Agent-Ready Ops",
    clientPromise: "Make recurring operations explicit enough that agents can assist safely under evidence, SOP, and approval controls.",
    bestFor: ["Businesses with recurring delivery/admin work but weak SOPs, roles, handoffs, or quality checks."],
    deliverables: [
      "Role and SOP coverage map",
      "Governed work queue and escalation rules",
      "Quality/checkpoint evidence plan",
      "Agent-ready operating cadence",
    ],
    boundaries: [OWNER_APPROVAL_BOUNDARY, "Agents remain supervised until operating evidence, rollback paths, and pause rules are proven."],
  },
  {
    slug: "ongoing-managed-business-os",
    title: "Ongoing Managed Business OS",
    clientPromise: "Keep the Business OS running with regular reviews, evidence refresh, governed actions, and owner-visible outcomes.",
    bestFor: ["Businesses with a baseline Business OS that now need ongoing management and improvement."],
    deliverables: [
      "Monthly Business OS review",
      "Managed action queue and approval register",
      "Evidence refresh and unknowns cleanup",
      "Outcome reporting and next-cycle roadmap",
    ],
    boundaries: [OWNER_APPROVAL_BOUNDARY, "Managed operations stay inside the agreed approval, spend, data, and customer-contact policy."],
  },
];

export type BusinessOsDiagnosticExportInput = {
  dashboard: Dashboard;
  variant: DiagnosticVariant;
  generatedAt?: string;
};

export type BusinessOsDiagnosticExport = ReturnType<typeof buildBusinessOsDiagnosticExport>;

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function serviceTemplate(slug: ServicePackageTemplate["slug"]): ServicePackageTemplate {
  const template = SERVICE_PACKAGE_TEMPLATES.find((candidate) => candidate.slug === slug);
  if (!template) throw new Error(`Unknown service package template: ${slug}`);
  return template;
}

function chooseServicePackage(dashboard: Dashboard): ServicePackageTemplate {
  const systems = dashboard.systemMaturity.systems;
  const weakKeys = new Set(dashboard.systemMaturity.atRiskSystems.map((label) => label.toLowerCase()));
  const lowest = systems.slice().sort((a, b) => a.score - b.score)[0];
  const lowestKey = lowest?.key ?? "";
  const hasFinanceWeakness = lowestKey === "finance_admin"
    || weakKeys.has("finance/admin")
    || weakKeys.has("finance and admin")
    || dashboard.openGaps.some((gap) => `${gap.title} ${gap.systemKey ?? ""}`.toLowerCase().includes("finance"));
  if (hasFinanceWeakness) return serviceTemplate("admin-finance-setup");

  const hasRevenueWeakness = [lowestKey, ...dashboard.openGaps.map((gap) => gap.systemKey ?? "")]
    .some((key) => ["revenue_sales", "revenue_marketing", "sales_conversion", "marketing_attention"].includes(key));
  if (hasRevenueWeakness) return serviceTemplate("revenue-engine-setup");

  const hasOpsWeakness = [lowestKey, ...dashboard.openGaps.map((gap) => gap.systemKey ?? "")]
    .some((key) => ["ops_delivery", "delivery_operations", "people_sops", "people_roles_sops"].includes(key));
  if (hasOpsWeakness) return serviceTemplate("agent-ready-ops");

  if ((dashboard.auditScorecard.score ?? 0) >= 65 && dashboard.systemMaturity.atRiskSystems.length === 0) {
    return serviceTemplate("ongoing-managed-business-os");
  }
  return serviceTemplate("audit");
}

function topActions(dashboard: Dashboard): DashboardAction[] {
  return dashboard.priorityActions.slice(0, 5);
}

function buildRoadmap(dashboard: Dashboard, recommended: ServicePackageTemplate) {
  const actions = topActions(dashboard);
  return {
    next30Days: actions.slice(0, 3).map((action) => ({
      title: action.title,
      systemKey: action.systemKey ?? inferSystemKey(action, dashboard),
      expectedOutcome: action.expectedOutcome,
      measurementMetric: action.conversionAffordance.contract.measurementMetric,
      ownerApprovalRequired: action.conversionAffordance.contract.ownerApprovalRequired,
    })),
    next60Days: [
      `Stabilise the recommended ${recommended.title} package and convert the top weak system into a governed operating cadence.`,
      "Refresh evidence for weak or unknown systems and close the highest-risk unknowns before increasing autonomy.",
    ],
    next90Days: [
      "Move from setup/audit into Ongoing Managed Business OS once evidence is current and approvals are operating normally.",
      "Review whether controlled autonomy can safely expand based on measured outcomes, not assumptions.",
    ],
  };
}

function inferSystemKey(action: DashboardAction, dashboard: Dashboard): string | null {
  const title = `${action.title} ${action.brief}`.toLowerCase();
  if (title.includes("finance") || title.includes("admin") || title.includes("bookkeeping")) return "finance_admin";
  if (title.includes("sales") || title.includes("lead") || title.includes("revenue") || title.includes("conversion")) return "revenue_sales";
  if (title.includes("marketing") || title.includes("campaign")) return "revenue_marketing";
  if (title.includes("sop") || title.includes("role")) return "people_sops";
  if (title.includes("delivery") || title.includes("operations")) return "ops_delivery";
  return dashboard.systemMaturity.systems[0]?.key ?? null;
}

function isClientSafeEvidenceLabel(label: string): boolean {
  return !/internal|runtime|task|hivewright-[\w-]+/i.test(label)
    && !/(^|\s)\/(api|deliverables|tasks?|work-products?)\b/i.test(label)
    && !/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|[^\s/]*\.local)(?:\b|[:/])/i.test(label);
}

function buildEvidence(dashboard: Dashboard, clientSafe: boolean) {
  const allEvidence = [
    ...dashboard.auditScorecard.evidence,
    ...dashboard.priorityActions.flatMap((action) => action.evidence),
    ...dashboard.systemMaturity.systems.flatMap((system) => system.evidence),
  ];
  const evidence = clientSafe ? allEvidence.filter(isClientSafeEvidenceLabel) : allEvidence;
  return unique(evidence).slice(0, 12);
}

export function buildBusinessOsDiagnosticExport(input: BusinessOsDiagnosticExportInput) {
  const dashboard = input.dashboard;
  const clientSafe = input.variant === "client_safe";
  const recommendedServicePackage = chooseServicePackage(dashboard);
  const priorityRoadmap = buildRoadmap(dashboard, recommendedServicePackage);

  return {
    variant: input.variant,
    clientSafe,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    currentState: {
      businessName: dashboard.headline.replace(/ Business OS .*/, ""),
      mode: dashboard.mode,
      stage: dashboard.stage,
      summary: dashboard.summary,
      ownerGoals: dashboard.ownerGoals,
      overallReadinessScore: dashboard.auditScorecard.score ?? dashboard.systemMaturity.averageReadinessScore,
      readinessConfidence: dashboard.auditScorecard.confidence,
      auditStatus: dashboard.auditScorecard.status,
      evidenceState: dashboard.systemMaturity.readinessEvidenceState,
      setupProgress: dashboard.setupProgress,
      governance: dashboard.governance,
    },
    readinessScores: dashboard.systemMaturity.systems.map((system: DashboardSystem) => ({
      systemKey: system.key,
      label: system.label,
      score: system.score,
      maturity: system.maturity,
      confidence: system.confidence,
      summary: system.summary,
    })),
    evidenceAndUnknowns: {
      evidence: buildEvidence(dashboard, clientSafe),
      unknowns: dashboard.auditScorecard.knownUnknowns,
      caveat: "Evidence labels are diagnostic inputs, not autonomous permission to act.",
    },
    priorityRoadmap,
    recommendedServicePackage,
    servicePackageTemplates: SERVICE_PACKAGE_TEMPLATES,
    next30_60_90: {
      days30: priorityRoadmap.next30Days.map((item) => item.title),
      days60: priorityRoadmap.next60Days,
      days90: priorityRoadmap.next90Days,
    },
    ...(clientSafe ? {} : {
      internalTrace: {
        agentActivity: dashboard.agentActivity,
        changedSinceLastReview: dashboard.changedSinceLastReview,
      },
    }),
  };
}
