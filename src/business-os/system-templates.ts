import type {
  MarketingAsset,
  MarketingCampaign,
  MarketingMetricSnapshot,
} from "@/marketing-os/foundation";
import type {
  SalesActionPlan,
  SalesBottleneck,
  SalesFunnel,
} from "@/sales-os/foundation";

export type BusinessMode = "new_business" | "existing_business";

export type BusinessSystemKey =
  | "strategy_governance"
  | "marketing_attention"
  | "sales_conversion"
  | "delivery_operations"
  | "finance_admin"
  | "customer_success_reviews_referrals"
  | "people_roles_sops"
  | "compliance_risk"
  | "software_integrations_data"
  | "ai_governance";

export type BusinessMaturityLevel = "missing" | "ad_hoc" | "defined" | "managed" | "optimising";
export type BusinessConfidence = "low" | "medium" | "high";
export type BusinessRiskLevel = "low" | "medium" | "high";

export type BusinessReadinessCriterion = {
  key: string;
  label: string;
  description: string;
  evidenceKind: "owner_answer" | "structured_state" | "connector" | "document" | "manual_check";
  requiredForLaunch: boolean;
};

export type BusinessTemplateActionCandidate = {
  type: "owner_task" | "agent_task" | "approval_request" | "connector_action" | "operating_loop_run" | "schedule" | "manual_check";
  title: string;
  brief: string;
  riskLevel: BusinessRiskLevel;
  approvalRequired: boolean;
  priority: number;
  expectedOutcome: string;
  measurementPlan: Record<string, unknown>;
};

export type BusinessSystemTemplate = {
  systemKey: BusinessSystemKey;
  systemLabel: string;
  ownerPromise: string;
  supportedModes: readonly BusinessMode[];
  readinessCriteria: readonly BusinessReadinessCriterion[];
  setupActionCandidates: readonly BusinessTemplateActionCandidate[];
  auditActionCandidates: readonly BusinessTemplateActionCandidate[];
};

export type BusinessTemplateReadiness = {
  systemKey: BusinessSystemKey;
  systemLabel: string;
  readinessScore: number;
  maturityLevel: BusinessMaturityLevel;
  confidence: BusinessConfidence;
  summary: string;
  criteria: readonly BusinessReadinessCriterion[];
};

export type BusinessTemplateGap = {
  systemKey: BusinessSystemKey;
  gapType: "missing_system" | "weak_process" | "missing_data" | "approval_gap" | "tool_gap" | "compliance_risk" | "measurement_gap" | "capacity_gap";
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  confidence: BusinessConfidence;
};

export type BusinessTemplateRecommendation = {
  systemKey: BusinessSystemKey;
  recommendationType:
    | "setup_task"
    | "operating_loop"
    | "connector_setup"
    | "owner_decision"
    | "sop"
    | "campaign"
    | "sales_action"
    | "finance_admin_action"
    | "risk_control";
  title: string;
  rationale: string;
  expectedOutcome: string;
  riskLevel: BusinessRiskLevel;
  requiresOwnerApproval: boolean;
};

export type BusinessTemplateOutput = {
  readiness: BusinessTemplateReadiness;
  gaps: BusinessTemplateGap[];
  recommendations: BusinessTemplateRecommendation[];
  actionCandidates: BusinessTemplateActionCandidate[];
};

function criterion(
  key: string,
  label: string,
  description: string,
  evidenceKind: BusinessReadinessCriterion["evidenceKind"] = "owner_answer",
  requiredForLaunch = true,
): BusinessReadinessCriterion {
  return { key, label, description, evidenceKind, requiredForLaunch };
}

function action(
  title: string,
  brief: string,
  expectedOutcome: string,
  measurementPlan: Record<string, unknown>,
  overrides: Partial<BusinessTemplateActionCandidate> = {},
): BusinessTemplateActionCandidate {
  return {
    type: "owner_task",
    title,
    brief,
    riskLevel: "low",
    approvalRequired: false,
    priority: 50,
    expectedOutcome,
    measurementPlan,
    ...overrides,
  };
}

export const BUSINESS_SYSTEM_TEMPLATES = [
  {
    systemKey: "strategy_governance",
    systemLabel: "Strategy and governance",
    ownerPromise: "The business has a clear direction, decision rights, constraints, and controlled autonomy rules.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("business_model", "Business model", "Target customer, offer, revenue path, and operating constraints are explicit."),
      criterion("decision_rights", "Decision rights", "Owner decisions, delegated decisions, and stop conditions are documented."),
      criterion("operating_cadence", "Operating cadence", "The business has a review rhythm for priorities, actions, metrics, and blockers."),
    ],
    setupActionCandidates: [
      action(
        "Define Business OS operating charter",
        "Capture the business model, owner goals, constraints, controlled autonomy posture, and first 30-day operating cadence.",
        "Owner and agents share one governed operating brief.",
        { metric: "operating_charter_completed", target: true, reviewCadence: "setup" },
        { priority: 95 },
      ),
    ],
    auditActionCandidates: [
      action(
        "Audit strategy and governance clarity",
        "Check whether the current business model, owner decision rights, operating cadence, and stop conditions are explicit enough for governed ops.",
        "Top governance gaps are visible before agents operate inside the business.",
        { metric: "strategy_governance_gaps_reviewed", target: true, reviewCadence: "audit" },
        { priority: 95 },
      ),
    ],
  },
  {
    systemKey: "marketing_attention",
    systemLabel: "Marketing attention",
    ownerPromise: "The business can earn attention through approved channels without unsafe public posting or spend.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("target_audience", "Target audience", "Audience and pains are explicit enough to draft attention tests."),
      criterion("channel_plan", "Channel plan", "Owned, partner, search, social, or paid channels are chosen with approval policy."),
      criterion("measurement", "Measurement", "Attention metrics and source attribution are available or manually tracked.", "structured_state"),
    ],
    setupActionCandidates: [
      action(
        "Draft first marketing attention test",
        "Prepare a draft-only marketing test with channel, audience, offer, copy outline, and success metric. Do not publish or spend without approval.",
        "Owner has a reviewable marketing test ready for approval.",
        { metric: "marketing_test_ready_for_review", target: true, approvalCategories: ["public", "spend"] },
        { type: "approval_request", approvalRequired: true, riskLevel: "high", priority: 85 },
      ),
    ],
    auditActionCandidates: [
      action(
        "Map current marketing campaigns into Business OS readiness",
        "Review active/draft campaigns, assets, approvals, and metrics to identify attention gaps and unsafe public/spend paths.",
        "Marketing readiness reflects real campaign state and owner approvals.",
        { metric: "marketing_state_mapped", target: true, reviewCadence: "audit" },
        { type: "operating_loop_run", approvalRequired: true, riskLevel: "medium", priority: 84 },
      ),
    ],
  },
  {
    systemKey: "sales_conversion",
    systemLabel: "Sales conversion",
    ownerPromise: "The business can turn demand into customers with measured, owner-approved customer-facing actions.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("funnel", "Funnel", "Lead stages and conversion events are defined."),
      criterion("scripts", "Scripts", "Sales scripts and qualification rules are draftable and reviewable."),
      criterion("conversion_metrics", "Conversion metrics", "Conversion counts and bottlenecks are tracked.", "structured_state"),
    ],
    setupActionCandidates: [
      action(
        "Draft first sales conversion path",
        "Create a draft sales script, qualification rule, and conversion event. Customer contact remains owner-approved.",
        "Owner can approve the first safe sales conversion workflow.",
        { metric: "sales_conversion_path_reviewed", target: true, conversionEvent: "first_qualified_call" },
        { approvalRequired: true, riskLevel: "medium", priority: 82 },
      ),
    ],
    auditActionCandidates: [
      action(
        "Identify the biggest sales funnel bottleneck",
        "Use current funnel state to find the largest conversion leak and propose one owner-approved fix.",
        "Business OS has one bounded sales improvement action with a next measurement.",
        { metric: "sales_bottleneck_action_created", target: true, reviewCadence: "next sales cycle" },
        { type: "operating_loop_run", approvalRequired: true, riskLevel: "medium", priority: 88 },
      ),
    ],
  },
  {
    systemKey: "delivery_operations",
    systemLabel: "Operations and delivery",
    ownerPromise: "The business can deliver the offer reliably with explicit process, capacity, handoffs, and quality checks.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("delivery_flow", "Delivery flow", "The end-to-end delivery workflow is documented."),
      criterion("capacity", "Capacity", "Capacity limits, lead times, and escalation rules are known."),
      criterion("quality_control", "Quality control", "Quality checks and issue handling are explicit."),
    ],
    setupActionCandidates: [
      action("Write launch delivery SOP", "Define the first delivery workflow, owner/operator responsibilities, quality checklist, and capacity limit.", "Delivery can be executed consistently after launch.", { metric: "delivery_sop_ready", target: true }, { priority: 75 }),
    ],
    auditActionCandidates: [
      action("Audit delivery bottlenecks", "Review fulfilment steps, capacity limits, handoffs, quality failures, and recurring blockers.", "Delivery gaps are converted into prioritised improvement actions.", { metric: "delivery_bottlenecks_ranked", target: true }, { priority: 78 }),
    ],
  },
  {
    systemKey: "finance_admin",
    systemLabel: "Finance and admin",
    ownerPromise: "The business has basic admin, bookkeeping, billing, reporting, and AI spend budget controls without autonomous financial changes.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("bookkeeping", "Bookkeeping", "Bookkeeping, invoice, receipt, and reconciliation responsibilities are defined."),
      criterion("cash_controls", "Cash controls", "Payment, refund, purchase, and spend approvals are explicit."),
      criterion("reporting", "Reporting", "Owner-visible financial/admin reporting cadence is chosen."),
    ],
    setupActionCandidates: [
      action("Complete finance/admin setup checklist", "Confirm bookkeeping, payment collection, invoicing, receipts, tax/compliance owner responsibilities, and AI spend budget. This is a checklist, not financial advice.", "Owner has a finance/admin baseline before trading.", { metric: "finance_admin_checklist_completed", target: true }, { type: "manual_check", approvalRequired: true, riskLevel: "medium", priority: 74 }),
    ],
    auditActionCandidates: [
      action("Audit finance/admin hygiene", "Review bookkeeping cadence, billing/reconciliation gaps, reporting freshness, and spend approval controls without making financial changes.", "Finance/admin risks are visible and actioned safely.", { metric: "finance_admin_risk_register_reviewed", target: true }, { type: "manual_check", approvalRequired: true, riskLevel: "medium", priority: 76 }),
    ],
  },
  {
    systemKey: "customer_success_reviews_referrals",
    systemLabel: "Customer success, reviews, and referrals",
    ownerPromise: "The business can keep customers successful, collect feedback, and request reviews/referrals with customer-message approvals.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("success_moments", "Success moments", "The expected customer outcome and success checks are defined."),
      criterion("feedback_loop", "Feedback loop", "Feedback, complaints, review, and referral moments are tracked."),
      criterion("message_approvals", "Message approvals", "Customer-facing messages require owner approval unless a policy allows otherwise."),
    ],
    setupActionCandidates: [
      action("Design customer success and review loop", "Define the first success check, feedback moment, review/referral request draft, and customer-message approval gate.", "Customer outcomes and review/referral loops are ready for owner review.", { metric: "customer_success_loop_ready", target: true }, { approvalRequired: true, riskLevel: "medium", priority: 68 }),
    ],
    auditActionCandidates: [
      action("Audit customer success and referral system", "Review customer outcomes, support gaps, review collection, referral asks, and complaint handling.", "Customer success gaps become safe improvement actions.", { metric: "customer_success_gaps_ranked", target: true }, { approvalRequired: true, riskLevel: "medium", priority: 72 }),
    ],
  },
  {
    systemKey: "people_roles_sops",
    systemLabel: "People, roles, and SOPs",
    ownerPromise: "Work is owned by explicit roles and repeatable SOPs, so agents and humans know who does what.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("role_map", "Role map", "Core responsibilities and owners are assigned."),
      criterion("sop_library", "SOP library", "Recurring work has SOPs or checklists."),
      criterion("handoffs", "Handoffs", "Handoff, escalation, and review paths are known."),
    ],
    setupActionCandidates: [
      action("Create initial role map and SOP backlog", "List core operating roles, the owner/default assignee, and the first SOPs needed before launch.", "The business has a role/SOP backlog agents can improve.", { metric: "role_sop_backlog_created", target: true }, { priority: 70 }),
    ],
    auditActionCandidates: [
      action("Audit role and SOP coverage", "Find recurring work without an owner, SOP, handoff, or quality check.", "Role/SOP gaps are converted into concrete documentation actions.", { metric: "sop_coverage_gaps_ranked", target: true }, { priority: 73 }),
    ],
  },
  {
    systemKey: "compliance_risk",
    systemLabel: "Compliance and risk",
    ownerPromise: "The business has practical risk controls and professional-advice boundaries before agents touch sensitive work.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("risk_register", "Risk register", "Key legal, financial, safety, privacy, and reputation risks are listed."),
      criterion("control_owner", "Control owner", "Each material risk has an owner or professional-advice note."),
      criterion("incident_path", "Incident path", "Escalation, pause, and incident paths are explicit."),
    ],
    setupActionCandidates: [
      action("Create compliance/risk checklist", "List material risks, owner responsibilities, professional-advice needs, and stop conditions. Do not treat this as legal/tax advice.", "Risk-sensitive work has explicit owner review boundaries.", { metric: "risk_checklist_reviewed", target: true }, { type: "manual_check", approvalRequired: true, riskLevel: "medium", priority: 80 }),
    ],
    auditActionCandidates: [
      action("Audit compliance/risk controls", "Review missing controls, stale obligations, privacy/customer-data risks, and external-action approval gaps.", "Compliance/risk gaps are visible before autonomy increases.", { metric: "risk_controls_reviewed", target: true }, { type: "manual_check", approvalRequired: true, riskLevel: "medium", priority: 86 }),
    ],
  },
  {
    systemKey: "software_integrations_data",
    systemLabel: "Software, integrations, and data",
    ownerPromise: "Systems of record, connectors, and evidence sources are known without duplicating credentials or leaking data.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("system_of_record", "Systems of record", "Core systems for customers, money, delivery, documents, and tasks are identified."),
      criterion("connector_plan", "Connector plan", "Connector setup is explicit and approved where needed.", "connector"),
      criterion("data_boundaries", "Data boundaries", "Private data, credentials, and cross-hive isolation boundaries are clear."),
    ],
    setupActionCandidates: [
      action("Map software stack and connector plan", "Identify systems of record, connector candidates, credential owners, and data boundaries. Do not create credentials automatically.", "Agents know where business evidence should come from after owner-approved connector setup.", { metric: "connector_plan_ready", target: true }, { type: "connector_action", approvalRequired: true, riskLevel: "medium", priority: 66 }),
    ],
    auditActionCandidates: [
      action("Audit systems of record and data gaps", "Review where business records live, connector coverage, manual evidence needs, and stale/missing data.", "Business OS can distinguish known facts from unknowns.", { metric: "systems_data_gap_map_completed", target: true }, { type: "connector_action", approvalRequired: true, riskLevel: "medium", priority: 79 }),
    ],
  },
  {
    systemKey: "ai_governance",
    systemLabel: "AI governance",
    ownerPromise: "Agents operate under controlled autonomy, approvals, evidence, rollback/pause rules, and AI spend budget visibility.",
    supportedModes: ["new_business", "existing_business"],
    readinessCriteria: [
      criterion("autonomy_policy", "Autonomy policy", "Allowed, approval-required, and blocked action categories are explicit."),
      criterion("ai_spend_budget", "AI spend budget", "AI spend budget and escalation thresholds are visible to the owner."),
      criterion("evidence_audit", "Evidence and audit", "Agent outputs preserve evidence, decisions, and rollback/pause notes."),
    ],
    setupActionCandidates: [
      action("Set controlled autonomy and AI spend budget", "Confirm supervised autonomy defaults, public/spend/customer-message gates, pause conditions, and AI spend budget display.", "Business OS starts with governed ops rather than uncontrolled execution.", { metric: "ai_governance_policy_confirmed", target: true }, { approvalRequired: true, riskLevel: "medium", priority: 92 }),
    ],
    auditActionCandidates: [
      action("Audit AI governance readiness", "Check autonomy policy, approval categories, evidence requirements, AI spend budget visibility, and stop/pause controls.", "Unsafe autonomy gaps are fixed before agents execute higher-risk work.", { metric: "ai_governance_gaps_closed_or_deferred", target: true }, { approvalRequired: true, riskLevel: "medium", priority: 90 }),
    ],
  },
] as const satisfies readonly BusinessSystemTemplate[];

export const BUSINESS_SYSTEM_TEMPLATE_KEYS = BUSINESS_SYSTEM_TEMPLATES.map((template) => template.systemKey);

export function getBusinessSystemTemplate(systemKey: BusinessSystemKey): BusinessSystemTemplate {
  const template = BUSINESS_SYSTEM_TEMPLATES.find((candidate) => candidate.systemKey === systemKey);
  if (!template) {
    throw new Error(`Unknown Business OS system template: ${systemKey}`);
  }
  return template;
}

export function getBusinessSystemTemplates(mode?: BusinessMode): readonly BusinessSystemTemplate[] {
  if (!mode) return BUSINESS_SYSTEM_TEMPLATES;
  return BUSINESS_SYSTEM_TEMPLATES.filter((template) => template.supportedModes.includes(mode));
}

function defaultScoreFor(mode: BusinessMode, template: BusinessSystemTemplate) {
  if (template.systemKey === "ai_governance") return 45;
  if (template.systemKey === "strategy_governance") return mode === "new_business" ? 35 : 30;
  return mode === "new_business" ? 20 : 25;
}

function defaultMaturityFor(score: number): BusinessMaturityLevel {
  if (score >= 80) return "managed";
  if (score >= 60) return "defined";
  if (score >= 30) return "ad_hoc";
  return "missing";
}

function gapTypeFor(systemKey: BusinessSystemKey): BusinessTemplateGap["gapType"] {
  switch (systemKey) {
    case "compliance_risk":
      return "compliance_risk";
    case "software_integrations_data":
      return "tool_gap";
    case "finance_admin":
    case "ai_governance":
    case "marketing_attention":
      return "approval_gap";
    case "delivery_operations":
    case "people_roles_sops":
    case "customer_success_reviews_referrals":
      return "weak_process";
    default:
      return "missing_system";
  }
}

function recommendationTypeFor(systemKey: BusinessSystemKey): BusinessTemplateRecommendation["recommendationType"] {
  switch (systemKey) {
    case "marketing_attention":
      return "campaign";
    case "sales_conversion":
      return "sales_action";
    case "finance_admin":
      return "finance_admin_action";
    case "delivery_operations":
    case "people_roles_sops":
    case "customer_success_reviews_referrals":
      return "sop";
    case "compliance_risk":
    case "ai_governance":
      return "risk_control";
    case "software_integrations_data":
      return "connector_setup";
    default:
      return "setup_task";
  }
}

export function buildBusinessSystemTemplateOutput(
  template: BusinessSystemTemplate,
  mode: BusinessMode,
  evidence: Partial<Pick<BusinessTemplateReadiness, "readinessScore" | "maturityLevel" | "confidence" | "summary">> = {},
): BusinessTemplateOutput {
  const actionCandidates = mode === "new_business" ? template.setupActionCandidates : template.auditActionCandidates;
  const readinessScore = evidence.readinessScore ?? defaultScoreFor(mode, template);
  const maturityLevel = evidence.maturityLevel ?? defaultMaturityFor(readinessScore);
  const confidence = evidence.confidence ?? (mode === "new_business" ? "low" : "medium");
  const summary = evidence.summary ?? `${template.systemLabel} template is ready for ${mode === "new_business" ? "setup" : "audit"} state, gaps, and governed actions.`;
  const primaryAction = actionCandidates[0];

  return {
    readiness: {
      systemKey: template.systemKey,
      systemLabel: template.systemLabel,
      readinessScore,
      maturityLevel,
      confidence,
      summary,
      criteria: template.readinessCriteria,
    },
    gaps: [
      {
        systemKey: template.systemKey,
        gapType: gapTypeFor(template.systemKey),
        severity: primaryAction.riskLevel === "high" ? "high" : "medium",
        title: `${template.systemLabel} needs ${mode === "new_business" ? "setup" : "audit"} evidence`,
        description: `${template.ownerPromise} Current state should be checked against ${template.readinessCriteria.length} readiness criteria before agents rely on it.`,
        confidence,
      },
    ],
    recommendations: [
      {
        systemKey: template.systemKey,
        recommendationType: recommendationTypeFor(template.systemKey),
        title: primaryAction.title,
        rationale: primaryAction.brief,
        expectedOutcome: primaryAction.expectedOutcome,
        riskLevel: primaryAction.riskLevel,
        requiresOwnerApproval: primaryAction.approvalRequired,
      },
    ],
    actionCandidates: [...actionCandidates],
  };
}

export function buildBusinessSystemTemplateOutputs(mode: BusinessMode): BusinessTemplateOutput[] {
  return getBusinessSystemTemplates(mode).map((template) => buildBusinessSystemTemplateOutput(template, mode));
}

export function mapMarketingOsToBusinessSystem(input: {
  campaigns?: readonly MarketingCampaign[];
  assets?: readonly MarketingAsset[];
  metricSnapshots?: readonly MarketingMetricSnapshot[];
}): BusinessTemplateOutput {
  const template = getBusinessSystemTemplate("marketing_attention");
  const campaigns = input.campaigns ?? [];
  const assets = input.assets ?? [];
  const metrics = input.metricSnapshots ?? [];
  const approvedAssets = assets.filter((asset) => asset.approvalStatus === "approved");
  const publicOrSpendPending = campaigns.some((campaign) => campaign.channels.includes("ads") || (campaign.spendBudgetCents ?? 0) > 0)
    || assets.some((asset) => asset.approvalStatus === "pending_owner_approval" || asset.publicationStatus === "queued");
  const readinessScore = Math.min(
    100,
    25
      + (campaigns.length > 0 ? 20 : 0)
      + (assets.length > 0 ? 15 : 0)
      + (approvedAssets.length > 0 ? 15 : 0)
      + (metrics.length > 0 ? 20 : 0),
  );
  const output = buildBusinessSystemTemplateOutput(template, "existing_business", {
    readinessScore,
    maturityLevel: defaultMaturityFor(readinessScore),
    confidence: metrics.length > 0 ? "high" : campaigns.length > 0 ? "medium" : "low",
    summary: campaigns.length > 0
      ? `${campaigns.length} marketing campaign(s), ${assets.length} asset(s), and ${metrics.length} metric snapshot(s) mapped into Business OS readiness.`
      : "No Marketing OS campaign state is available yet; Business OS should start with a draft attention test.",
  });

  if (publicOrSpendPending) {
    output.gaps.push({
      systemKey: "marketing_attention",
      gapType: "approval_gap",
      severity: "high",
      title: "Marketing public or spend action needs owner approval",
      description: "Marketing OS has queued, paid, public, or pending-approval state that must stay gated before execution.",
      confidence: campaigns.length > 0 ? "medium" : "low",
    });
    output.actionCandidates.unshift(action(
      "Review Marketing OS public/spend approvals",
      "Review queued marketing assets, ads, spend budget, and publication state before any public or spend-sensitive execution.",
      "No marketing public/spend action proceeds without owner approval.",
      { metric: "marketing_approval_review_completed", target: true, approvalCategories: ["public", "spend"] },
      { type: "approval_request", approvalRequired: true, riskLevel: "high", priority: 92 },
    ));
  }

  return output;
}

export function mapSalesOsToBusinessSystem(input: {
  funnel?: SalesFunnel | null;
  bottleneck?: SalesBottleneck | null;
  actionPlan?: SalesActionPlan | null;
}): BusinessTemplateOutput {
  const template = getBusinessSystemTemplate("sales_conversion");
  const bottleneck = input.bottleneck ?? input.funnel?.biggestLeak ?? input.actionPlan?.bottleneck ?? null;
  const stageCount = input.funnel?.stages.length ?? 0;
  const readinessScore = Math.min(100, 25 + (stageCount > 0 ? 25 : 0) + (bottleneck ? 20 : 0) + (input.actionPlan ? 15 : 0));
  const output = buildBusinessSystemTemplateOutput(template, "existing_business", {
    readinessScore,
    maturityLevel: defaultMaturityFor(readinessScore),
    confidence: input.funnel ? "high" : "low",
    summary: input.funnel
      ? `Sales funnel ${input.funnel.id} mapped with ${stageCount} stage(s) and ${bottleneck ? `${bottleneck.severity} bottleneck ${bottleneck.fromStage} → ${bottleneck.toStage}` : "no bottleneck"}.`
      : "No Sales OS funnel state is available yet; Business OS should define conversion stages before customer outreach.",
  });

  if (bottleneck) {
    output.gaps.push({
      systemKey: "sales_conversion",
      gapType: "weak_process",
      severity: bottleneck.severity,
      title: `Sales funnel leaks at ${bottleneck.fromStage} → ${bottleneck.toStage}`,
      description: `${bottleneck.lostCount} opportunity/opportunities are lost at this stage pair. Create one bounded, owner-approved conversion fix before outreach.` ,
      confidence: "high",
    });
    output.actionCandidates.unshift(action(
      `Fix sales bottleneck: ${bottleneck.fromStage} → ${bottleneck.toStage}`,
      "Prepare one owner-approved sales conversion fix tied to the current bottleneck. Do not send outbound customer messages without approval.",
      "One measured sales conversion improvement is queued with approval and next measurement.",
      { metric: "bottleneck_conversion_rate", baseline: bottleneck.conversionRate, reviewCadence: "next sales cycle" },
      { approvalRequired: true, riskLevel: bottleneck.severity === "high" ? "high" : "medium", priority: 90, type: "approval_request" },
    ));
  }

  return output;
}
