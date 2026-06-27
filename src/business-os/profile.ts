import type { JSONValue, Sql, TransactionSql } from "postgres";
import { buildBusinessSystemTemplateOutputs } from "@/business-os/system-templates";

export const BUSINESS_MODES = ["new_business", "existing_business"] as const;

export type BusinessMode = typeof BUSINESS_MODES[number];
export type BusinessSetupSourceKind = "setup" | "audit" | "manual_update" | "loop_measurement";

export type BusinessOsProfileInput = {
  mode?: BusinessMode | string | null;
  businessName?: string | null;
  industry?: string | null;
  stage?: string | null;
  summary?: string | null;
  ownerGoals?: unknown;
  constraints?: unknown;
  approvalPolicy?: unknown;
  aiSpendBudget?: unknown;
  autonomyPolicy?: unknown;
  sourceProfile?: unknown;
};

export type NewBusinessSetupInput = {
  idea?: string | null;
  feasibilityRisks?: unknown;
  customerSegments?: unknown;
  problemStatements?: unknown;
  offers?: unknown;
  pricingModel?: unknown;
  businessBlueprint?: unknown;
  brandPositioning?: unknown;
  salesModel?: unknown;
  marketingModel?: unknown;
  deliveryModel?: unknown;
  adminFinanceModel?: unknown;
  legalComplianceChecklist?: unknown;
  toolStack?: unknown;
  rolesAndSops?: unknown;
  launchReadiness?: unknown;
  launchRoadmap?: unknown;
  launchActions?: unknown;
  initialLoops?: unknown;
};

export type ExistingBusinessAuditInput = {
  scope?: unknown;
  evidenceSources?: unknown;
  knownUnknowns?: unknown;
};

export type BusinessOsProfile = {
  id: string;
  hiveId: string;
  businessMode: BusinessMode;
  businessName: string;
  industry: string | null;
  stage: string | null;
  summary: string | null;
  ownerGoals: string[];
  constraints: string[];
  approvalPolicy: Record<string, unknown>;
  aiSpendBudget: Record<string, unknown>;
  autonomyPolicy: Record<string, unknown>;
  sourceProfile: Record<string, unknown>;
};

type SqlExecutor = Sql | TransactionSql;
type JsonSqlExecutor = SqlExecutor & { json: Sql["json"] };

type BusinessOsProfileRow = {
  id: string;
  hive_id: string;
  business_mode: string;
  business_name: string;
  industry: string | null;
  stage: string | null;
  summary: string | null;
  owner_goals: unknown;
  constraints: unknown;
  approval_policy: unknown;
  ai_spend_budget: unknown;
  autonomy_policy: unknown;
  source_profile: unknown;
};

type ReadinessSeed = {
  systemKey: string;
  systemLabel: string;
  score: number;
  maturityLevel: "missing" | "ad_hoc" | "defined";
  confidence: "low" | "medium";
  summary: string;
};

type GapSeed = {
  systemKey: string;
  gapType: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  recommendationType: string;
  recommendationTitle: string;
  rationale: string;
  expectedOutcome: string;
  actionType: string;
  actionTitle: string;
  actionBrief: string;
  actionStatus: "queued" | "awaiting_approval";
  priority: number;
  riskLevel: "low" | "medium" | "high";
  approvalRequired: boolean;
  measurementPlan: Record<string, unknown>;
};

const businessModeSet = new Set<string>(BUSINESS_MODES);

const DEFAULT_APPROVAL_POLICY = {
  defaultPreset: "owner_review_first",
  publicActions: "owner_approval_required",
  spendActions: "owner_approval_required",
  customerMessages: "owner_approval_required",
  systemChanges: "owner_approval_required",
  destructiveActions: "blocked",
};

const DEFAULT_AUTONOMY_POLICY = {
  posture: "supervised",
  externalActions: "owner_approval_required",
  publicOrSpendSensitiveActions: "owner_approval_required",
  reportOnlyCompletion: "disallowed",
};

export function isBusinessMode(value: unknown): value is BusinessMode {
  return typeof value === "string" && businessModeSet.has(value);
}

export function normalizeBusinessMode(value: unknown): BusinessMode {
  return isBusinessMode(value) ? value : "new_business";
}

function trimText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function normalizeTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(trimText).filter((item): item is string => Boolean(item))));
  }
  const single = trimText(value);
  return single ? [single] : [];
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeObjectList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeObject).filter(hasObjectContent);
}

function hasObjectContent(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
}

function rowToProfile(row: BusinessOsProfileRow): BusinessOsProfile {
  return {
    id: row.id,
    hiveId: row.hive_id,
    businessMode: normalizeBusinessMode(row.business_mode),
    businessName: row.business_name,
    industry: row.industry,
    stage: row.stage,
    summary: row.summary,
    ownerGoals: normalizeTextList(row.owner_goals),
    constraints: normalizeTextList(row.constraints),
    approvalPolicy: normalizeObject(row.approval_policy),
    aiSpendBudget: normalizeObject(row.ai_spend_budget),
    autonomyPolicy: normalizeObject(row.autonomy_policy),
    sourceProfile: normalizeObject(row.source_profile),
  };
}

function normalizeSetupInput(input: NewBusinessSetupInput | undefined, profile: BusinessOsProfileInput): Required<NewBusinessSetupInput> {
  const idea = trimText(input?.idea) ?? trimText(profile.summary) ?? trimText(profile.businessName) ?? "New business idea to validate";
  const feasibilityRisks = normalizeTextList(input?.feasibilityRisks);
  const businessBlueprint = normalizeObject(input?.businessBlueprint);
  const launchReadiness = normalizeTextList(input?.launchReadiness);
  const launchRoadmap = normalizeTextList(input?.launchRoadmap);
  const launchActions = normalizeTextList(input?.launchActions);
  const initialLoops = normalizeTextList(input?.initialLoops);
  const brandPositioning = {
    ...normalizeObject(input?.brandPositioning),
    ...(feasibilityRisks.length > 0 ? { feasibilityRisks } : {}),
    ...(hasObjectContent(businessBlueprint) ? { businessBlueprint } : {}),
    ...(launchReadiness.length > 0 ? { launchReadiness } : {}),
    ...(launchRoadmap.length > 0 ? { launchRoadmap } : {}),
    ...(launchActions.length > 0 ? { launchActions } : {}),
    ...(initialLoops.length > 0 ? { initialLoops } : {}),
  };
  return {
    idea,
    feasibilityRisks,
    customerSegments: normalizeTextList(input?.customerSegments),
    problemStatements: normalizeTextList(input?.problemStatements),
    offers: normalizeTextList(input?.offers),
    pricingModel: normalizeObject(input?.pricingModel),
    businessBlueprint,
    brandPositioning,
    salesModel: normalizeObject(input?.salesModel),
    marketingModel: normalizeObject(input?.marketingModel),
    deliveryModel: normalizeObject(input?.deliveryModel),
    adminFinanceModel: normalizeObject(input?.adminFinanceModel),
    legalComplianceChecklist: normalizeTextList(input?.legalComplianceChecklist),
    toolStack: normalizeTextList(input?.toolStack),
    rolesAndSops: normalizeTextList(input?.rolesAndSops),
    launchReadiness,
    launchRoadmap,
    launchActions,
    initialLoops,
  } satisfies Required<NewBusinessSetupInput> & { idea: string };
}

function readinessSeeds(setup: Required<NewBusinessSetupInput>): ReadinessSeed[] {
  const listScore = (items: unknown, strong = 55) => normalizeTextList(items).length > 0 ? strong : 15;
  const objectScore = (value: unknown, strong = 55) => hasObjectContent(normalizeObject(value)) ? strong : 15;
  const seeds: ReadinessSeed[] = [
    { systemKey: "strategy_governance", systemLabel: "Strategy and governance", score: 35, maturityLevel: "ad_hoc", confidence: "low", summary: "Initial business idea captured; governance remains owner-reviewed." },
    { systemKey: "customer_market", systemLabel: "Customer and market", score: listScore(setup.customerSegments, 60), maturityLevel: normalizeTextList(setup.customerSegments).length ? "defined" : "missing", confidence: "medium", summary: "Customer segments captured for validation." },
    { systemKey: "offer_pricing", systemLabel: "Offer and pricing", score: Math.max(listScore(setup.offers, 60), objectScore(setup.pricingModel, 55)), maturityLevel: normalizeTextList(setup.offers).length ? "defined" : "ad_hoc", confidence: "medium", summary: "Offer/pricing hypothesis is ready for owner validation." },
    { systemKey: "marketing_attention", systemLabel: "Marketing attention", score: objectScore(setup.marketingModel, 45), maturityLevel: hasObjectContent(setup.marketingModel as Record<string, unknown>) ? "ad_hoc" : "missing", confidence: "low", summary: "Marketing channels are draft-only until owner approves public work." },
    { systemKey: "sales_conversion", systemLabel: "Sales conversion", score: objectScore(setup.salesModel, 45), maturityLevel: hasObjectContent(setup.salesModel as Record<string, unknown>) ? "ad_hoc" : "missing", confidence: "low", summary: "Sales motion needs scripts and measurement before customer outreach." },
    { systemKey: "delivery_operations", systemLabel: "Delivery and operations", score: objectScore(setup.deliveryModel, 45), maturityLevel: hasObjectContent(setup.deliveryModel as Record<string, unknown>) ? "ad_hoc" : "missing", confidence: "low", summary: "Delivery path is sketched; SOPs and capacity checks remain." },
    { systemKey: "finance_admin", systemLabel: "Finance and admin", score: objectScore(setup.adminFinanceModel, 40), maturityLevel: hasObjectContent(setup.adminFinanceModel as Record<string, unknown>) ? "ad_hoc" : "missing", confidence: "low", summary: "Finance/admin checklist is not execution-ready without owner review." },
    { systemKey: "compliance_risk", systemLabel: "Compliance and risk", score: listScore(setup.legalComplianceChecklist, 35), maturityLevel: normalizeTextList(setup.legalComplianceChecklist).length ? "ad_hoc" : "missing", confidence: "low", summary: "Compliance items are checklist prompts, not legal advice." },
    { systemKey: "software_integrations_data", systemLabel: "Software, integrations, and data", score: listScore(setup.toolStack, 40), maturityLevel: normalizeTextList(setup.toolStack).length ? "ad_hoc" : "missing", confidence: "low", summary: "Tool stack candidates are captured; connector setup should remain explicit." },
    { systemKey: "people_roles_sops", systemLabel: "People, roles, and SOPs", score: listScore(setup.rolesAndSops, 35), maturityLevel: normalizeTextList(setup.rolesAndSops).length ? "ad_hoc" : "missing", confidence: "low", summary: "Initial SOP needs captured; role ownership still needs definition." },
    { systemKey: "ai_governance", systemLabel: "AI governance", score: 45, maturityLevel: "defined", confidence: "medium", summary: "Controlled autonomy defaults require owner approval for public/spend/customer-facing actions." },
  ];

  const seededSystems = new Set(seeds.map((seed) => seed.systemKey));
  const templateSeeds = buildBusinessSystemTemplateOutputs("new_business")
    .filter((output) => !seededSystems.has(output.readiness.systemKey))
    .map((output): ReadinessSeed => ({
      systemKey: output.readiness.systemKey,
      systemLabel: output.readiness.systemLabel,
      score: output.readiness.readinessScore,
      maturityLevel: output.readiness.maturityLevel === "managed" || output.readiness.maturityLevel === "optimising" ? "defined" : output.readiness.maturityLevel,
      confidence: output.readiness.confidence === "high" ? "medium" : output.readiness.confidence,
      summary: output.readiness.summary,
    }));

  return [...seeds, ...templateSeeds];
}

function gapSeeds(setup: Required<NewBusinessSetupInput>): GapSeed[] {
  const offer = normalizeTextList(setup.offers)[0] ?? "the first offer";
  const seeds: GapSeed[] = [
    {
      systemKey: "customer_market",
      gapType: "missing_data",
      severity: "high",
      title: "Validate target customer and problem",
      description: "The setup has a customer hypothesis, but no evidence-backed validation yet.",
      recommendationType: "setup_task",
      recommendationTitle: "Run customer/problem validation",
      rationale: "A new business should not proceed to launch work until the customer/problem hypothesis is tested.",
      expectedOutcome: "Owner has evidence for whether the target customer feels the problem strongly enough to buy.",
      actionType: "owner_task",
      actionTitle: "Validate customer/problem hypothesis",
      actionBrief: `Interview or otherwise validate whether target customers want ${offer}. Keep this as research until owner approves outreach wording.`,
      actionStatus: "queued",
      priority: 95,
      riskLevel: "low",
      approvalRequired: false,
      measurementPlan: { metric: "validated_customer_interviews", target: 5, reviewCadence: "before launch" },
    },
    {
      systemKey: "offer_pricing",
      gapType: "weak_process",
      severity: "medium",
      title: "Turn offer hypothesis into a testable package",
      description: "The offer/pricing model exists, but needs acceptance criteria and margin/capacity assumptions before launch.",
      recommendationType: "setup_task",
      recommendationTitle: "Define offer acceptance criteria",
      rationale: "Agents need a structured offer, price, and success criteria before creating sales or marketing assets.",
      expectedOutcome: "Offer has a clear promise, included scope, price assumption, and validation metric.",
      actionType: "owner_task",
      actionTitle: "Define first offer validation package",
      actionBrief: "Document the first offer promise, inclusions, price assumption, margin/capacity notes, and the validation metric.",
      actionStatus: "queued",
      priority: 90,
      riskLevel: "low",
      approvalRequired: false,
      measurementPlan: { metric: "offer_validation_package_completed", target: true, reviewCadence: "setup" },
    },
    {
      systemKey: "marketing_attention",
      gapType: "approval_gap",
      severity: "high",
      title: "Marketing launch needs owner approval",
      description: "Public launch or spend-sensitive marketing must stay gated until the owner approves the exact action.",
      recommendationType: "campaign",
      recommendationTitle: "Draft first marketing test for owner review",
      rationale: "Business OS can prepare draft-only marketing actions, but public posting and spend are external actions.",
      expectedOutcome: "A draft marketing test exists with approval required before publishing or spend.",
      actionType: "approval_request",
      actionTitle: "Request launch approval before public marketing or spend",
      actionBrief: "Prepare the first marketing test as a draft and require owner approval before any public post, ad spend, or external customer-facing action.",
      actionStatus: "awaiting_approval",
      priority: 85,
      riskLevel: "high",
      approvalRequired: true,
      measurementPlan: { metric: "owner_launch_approval", target: "approved_or_rejected", approvalCategories: ["public", "spend"] },
    },
    {
      systemKey: "sales_conversion",
      gapType: "weak_process",
      severity: "medium",
      title: "Sales conversion path is not ready to execute",
      description: "Sales motion is captured but needs a draft script, qualification rule, and conversion metric.",
      recommendationType: "sales_action",
      recommendationTitle: "Draft sales conversion path",
      rationale: "Customer-facing sales actions must be scripted and approval-gated before outreach.",
      expectedOutcome: "Owner can review the first sales script and conversion event before customer contact.",
      actionType: "owner_task",
      actionTitle: "Draft first sales script and conversion metric",
      actionBrief: "Create a draft sales script, qualification rule, and first conversion event. Do not send it to customers until approved.",
      actionStatus: "queued",
      priority: 80,
      riskLevel: "medium",
      approvalRequired: true,
      measurementPlan: { metric: "sales_script_reviewed", target: true, conversionEvent: "first_qualified_call" },
    },
    {
      systemKey: "finance_admin",
      gapType: "missing_system",
      severity: "medium",
      title: "Admin and finance baseline needs setup",
      description: "Bookkeeping, payments, and business admin need explicit owner-selected tools and checks before trading.",
      recommendationType: "finance_admin_action",
      recommendationTitle: "Create finance/admin setup checklist",
      rationale: "A launch plan without bookkeeping/payment controls creates downstream operational risk.",
      expectedOutcome: "Owner has a concrete finance/admin checklist with no autonomous financial changes.",
      actionType: "manual_check",
      actionTitle: "Complete finance/admin launch checklist",
      actionBrief: "Confirm bookkeeping, payment collection, invoices/receipts, and tax/compliance owner responsibilities. This is a checklist, not financial advice.",
      actionStatus: "queued",
      priority: 75,
      riskLevel: "medium",
      approvalRequired: true,
      measurementPlan: { metric: "finance_admin_checklist_completed", target: true, reviewCadence: "before trading" },
    },
    {
      systemKey: "delivery_operations",
      gapType: "weak_process",
      severity: "medium",
      title: "Delivery SOPs and roles need definition",
      description: "The delivery model needs SOPs, role ownership, and quality checks before launch.",
      recommendationType: "sop",
      recommendationTitle: "Create first delivery SOPs",
      rationale: "Agents can only run or improve delivery when the process is explicit and measurable.",
      expectedOutcome: "First delivery SOP and quality checklist are owner-reviewable.",
      actionType: "owner_task",
      actionTitle: "Write launch delivery SOP and quality checklist",
      actionBrief: "Define the first delivery workflow, owner/operator responsibilities, and quality checklist.",
      actionStatus: "queued",
      priority: 70,
      riskLevel: "low",
      approvalRequired: false,
      measurementPlan: { metric: "delivery_sop_ready", target: true, reviewCadence: "setup" },
    },
  ];

  const seededSystems = new Set(seeds.map((seed) => seed.systemKey));
  const templateSeeds = buildBusinessSystemTemplateOutputs("new_business")
    .filter((output) => !seededSystems.has(output.readiness.systemKey))
    .map((output): GapSeed => {
      const gap = output.gaps[0];
      const recommendation = output.recommendations[0];
      const candidate = output.actionCandidates[0];
      return {
        systemKey: output.readiness.systemKey,
        gapType: gap.gapType,
        severity: gap.severity,
        title: gap.title,
        description: gap.description,
        recommendationType: recommendation.recommendationType,
        recommendationTitle: recommendation.title,
        rationale: recommendation.rationale,
        expectedOutcome: recommendation.expectedOutcome,
        actionType: candidate.type,
        actionTitle: candidate.title,
        actionBrief: candidate.brief,
        actionStatus: candidate.approvalRequired ? "awaiting_approval" : "queued",
        priority: candidate.priority,
        riskLevel: candidate.riskLevel,
        approvalRequired: candidate.approvalRequired,
        measurementPlan: candidate.measurementPlan,
      };
    });

  return [...seeds, ...templateSeeds];
}

const DEFAULT_AUDIT_SCOPE = [
  "strategy_governance",
  "offer_pricing",
  "marketing_attention",
  "sales_conversion",
  "delivery_operations",
  "finance_admin",
  "people_roles_sops",
  "compliance_risk",
  "software_integrations_data",
  "ai_governance",
] as const;

function normalizeAuditInput(input: ExistingBusinessAuditInput | undefined): {
  scope: string[];
  evidenceSources: Array<Record<string, unknown>>;
  knownUnknowns: string[];
} {
  const scope = normalizeTextList(input?.scope);
  const evidenceSources = normalizeObjectList(input?.evidenceSources);
  const knownUnknowns = normalizeTextList(input?.knownUnknowns);
  return {
    scope: scope.length > 0 ? scope : [...DEFAULT_AUDIT_SCOPE],
    evidenceSources: evidenceSources.length > 0
      ? evidenceSources
      : [{ kind: "manual", label: "Owner-provided audit intake", summary: "No connector evidence supplied yet." }],
    knownUnknowns: knownUnknowns.length > 0 ? knownUnknowns : ["Evidence is manually supplied until connectors or records are reviewed."],
  };
}

function auditReadinessSeeds(audit: ReturnType<typeof normalizeAuditInput>): ReadinessSeed[] {
  const scoped = new Set(audit.scope);
  const evidenceCount = audit.evidenceSources.length;
  const baseScore = evidenceCount >= 2 ? 45 : 30;
  const seed = (systemKey: string, systemLabel: string, summary: string, scoreOffset = 0): ReadinessSeed => ({
    systemKey,
    systemLabel,
    score: Math.max(10, Math.min(75, baseScore + scoreOffset + (scoped.has(systemKey) ? 10 : 0))),
    maturityLevel: scoped.has(systemKey) ? "ad_hoc" : "missing",
    confidence: evidenceCount >= 2 ? "medium" : "low",
    summary,
  });
  return [
    seed("strategy_governance", "Strategy and governance", "Business direction exists, but agent operating boundaries and decision rights need to be explicit.", 0),
    seed("offer_pricing", "Offer and pricing", "Offer/pricing needs evidence-backed margin, capacity, and conversion assumptions.", 5),
    seed("marketing_attention", "Marketing attention", "Marketing foundations can be reused, but audit evidence must prove reliable attention generation.", 5),
    seed("sales_conversion", "Sales conversion", "Sales conversion readiness depends on a measurable funnel and owner-approved customer touchpoints.", 0),
    seed("delivery_operations", "Delivery and operations", "Delivery needs SOPs, quality controls, and capacity evidence before agents can run improvements.", -5),
    seed("finance_admin", "Finance and admin", "Finance/admin readiness is limited until bookkeeping/reporting evidence is verified.", -10),
    seed("people_roles_sops", "People, roles, and SOPs", "Roles and SOPs are weak if the business still depends on owner memory.", -10),
    seed("compliance_risk", "Compliance and risk", "Compliance/risk controls are checklist-level until verified by source evidence.", -5),
    seed("software_integrations_data", "Software, integrations, and data", "Connector and data freshness gaps limit autonomous operation.", 0),
    seed("ai_governance", "AI governance", "Controlled autonomy is usable only with owner approval gates and AI spend budget visibility.", 10),
  ];
}

function auditGapSeeds(): GapSeed[] {
  return [
    {
      systemKey: "strategy_governance",
      gapType: "weak_process",
      severity: "high",
      title: "Agent-ready operating model is incomplete",
      description: "The business needs explicit decision rights, operating cadence, success metrics, and stop conditions before agents can safely improve it.",
      recommendationType: "operating_loop",
      recommendationTitle: "Create audit improvement operating model",
      rationale: "Existing-business mode must turn audit findings into governed operating cycles, not another report.",
      expectedOutcome: "Owner can see the current state, top risks, and the next safe improvement cycle.",
      actionType: "owner_task",
      actionTitle: "Create audit improvement operating model",
      actionBrief: "Define decision rights, cadence, metrics, owner approval categories, and the first audit improvement loop.",
      actionStatus: "queued",
      priority: 95,
      riskLevel: "medium",
      approvalRequired: true,
      measurementPlan: { metric: "operating_model_reviewed", target: true, reviewCadence: "audit" },
    },
    {
      systemKey: "marketing_attention",
      gapType: "measurement_gap",
      severity: "medium",
      title: "Marketing attention evidence needs connection to the audit",
      description: "Marketing/Sales modules exist, but audit readiness needs visible evidence and measurement links.",
      recommendationType: "campaign",
      recommendationTitle: "Map marketing evidence into Business OS audit",
      rationale: "Reusing Growth OS evidence avoids duplicating modules and makes readiness scores explainable.",
      expectedOutcome: "Marketing readiness has evidence refs and a measurable next action.",
      actionType: "manual_check",
      actionTitle: "Map marketing evidence into the audit scorecard",
      actionBrief: "Link available marketing profile/campaign/metric evidence into the Business OS audit before recommending public work.",
      actionStatus: "queued",
      priority: 85,
      riskLevel: "low",
      approvalRequired: false,
      measurementPlan: { metric: "marketing_evidence_refs_linked", target: 3, reviewCadence: "audit" },
    },
    {
      systemKey: "sales_conversion",
      gapType: "weak_process",
      severity: "medium",
      title: "Sales conversion loop needs measurable bottlenecks",
      description: "The audit should identify conversion bottlenecks before drafting customer-facing actions.",
      recommendationType: "sales_action",
      recommendationTitle: "Capture sales funnel bottleneck evidence",
      rationale: "Agents need a measurable sales bottleneck before suggesting customer-facing improvements.",
      expectedOutcome: "Sales readiness is tied to a funnel stage, bottleneck, and safe next action.",
      actionType: "owner_task",
      actionTitle: "Capture current sales funnel bottlenecks",
      actionBrief: "Record current lead source, qualification step, conversion event, and bottleneck evidence. Do not contact customers from this action.",
      actionStatus: "queued",
      priority: 80,
      riskLevel: "low",
      approvalRequired: false,
      measurementPlan: { metric: "sales_bottlenecks_captured", target: true, reviewCadence: "audit" },
    },
    {
      systemKey: "finance_admin",
      gapType: "missing_data",
      severity: "high",
      title: "Finance/admin evidence is not verified",
      description: "Finance, bookkeeping, and reporting gaps cannot be safely improved until current systems and responsibilities are evidenced.",
      recommendationType: "finance_admin_action",
      recommendationTitle: "Verify finance/admin operating evidence",
      rationale: "Financial actions are sensitive and need owner-reviewed evidence before agents recommend changes.",
      expectedOutcome: "Finance/admin readiness shows verified systems, reporting cadence, and owner responsibilities.",
      actionType: "manual_check",
      actionTitle: "Verify finance/admin evidence before recommendations",
      actionBrief: "List bookkeeping system, payment flow, reporting cadence, invoice/receipt process, and owner-only financial decision boundaries.",
      actionStatus: "queued",
      priority: 78,
      riskLevel: "medium",
      approvalRequired: true,
      measurementPlan: { metric: "finance_admin_evidence_verified", target: true, reviewCadence: "audit" },
    },
    {
      systemKey: "people_roles_sops",
      gapType: "capacity_gap",
      severity: "medium",
      title: "Owner-memory SOPs block safe delegation",
      description: "Agents and staff cannot reliably operate the business while critical procedures live only in the owner’s head.",
      recommendationType: "sop",
      recommendationTitle: "Capture top operational SOPs",
      rationale: "SOP capture is a safe, high-leverage improvement before higher autonomy.",
      expectedOutcome: "At least three owner-reviewable SOPs exist for repeatable work.",
      actionType: "owner_task",
      actionTitle: "Capture top three repeatable SOPs",
      actionBrief: "Document the three most repeated operational processes, including owner approval points and quality checks.",
      actionStatus: "queued",
      priority: 72,
      riskLevel: "low",
      approvalRequired: false,
      measurementPlan: { metric: "sops_captured", target: 3, reviewCadence: "audit" },
    },
    {
      systemKey: "ai_governance",
      gapType: "approval_gap",
      severity: "high",
      title: "Owner approval required before public/spend/customer actions",
      description: "The audit can recommend improvements, but public, spend-sensitive, customer-facing, financial, and system-changing actions must remain approval-gated.",
      recommendationType: "owner_decision",
      recommendationTitle: "Confirm audit action approval gates",
      rationale: "Existing-business improvement has real-world blast radius; approval policy must be explicit before execution.",
      expectedOutcome: "High-risk audit improvements are awaiting approval rather than executing automatically.",
      actionType: "approval_request",
      actionTitle: "Request owner approval before high-risk audit improvements",
      actionBrief: "Prepare exact public/spend/customer-facing/system-change proposals for owner review; do not execute them automatically.",
      actionStatus: "awaiting_approval",
      priority: 70,
      riskLevel: "high",
      approvalRequired: true,
      measurementPlan: { metric: "owner_approval_for_high_risk_improvements", target: "approved_or_rejected", approvalCategories: ["public", "spend", "customer_message", "financial", "system_change"] },
    },
  ];
}

export function businessOsKindProfile(profile: BusinessOsProfile): Record<string, unknown> {
  return {
    businessMode: profile.businessMode,
    businessName: profile.businessName,
    businessOs: {
      industry: profile.industry,
      stage: profile.stage,
      summary: profile.summary,
      ownerGoals: profile.ownerGoals,
      constraints: profile.constraints,
      approvalPolicy: profile.approvalPolicy,
      aiSpendBudget: profile.aiSpendBudget,
      autonomyPolicy: profile.autonomyPolicy,
    },
  };
}

export async function getBusinessOsProfile(sql: SqlExecutor, hiveId: string): Promise<BusinessOsProfile | null> {
  const [row] = await sql<BusinessOsProfileRow[]>`
    SELECT
      id,
      hive_id,
      business_mode,
      business_name,
      industry,
      stage,
      summary,
      owner_goals,
      constraints,
      approval_policy,
      ai_spend_budget,
      autonomy_policy,
      source_profile
    FROM business_os_profiles
    WHERE hive_id = ${hiveId}::uuid
    LIMIT 1
  `;
  return row ? rowToProfile(row) : null;
}

export async function upsertBusinessOsProfile(
  sql: JsonSqlExecutor,
  hiveId: string,
  input: BusinessOsProfileInput = {},
): Promise<BusinessOsProfile> {
  const [hive] = await sql<{ name: string; kind: string | null }[]>`
    SELECT name, kind FROM hives WHERE id = ${hiveId}::uuid LIMIT 1
  `;
  if (!hive) {
    throw new Error("hive not found");
  }
  if (hive.kind !== "business") {
    throw new Error("Business OS profiles can only be attached to business hives.");
  }

  const businessMode = normalizeBusinessMode(input.mode);
  const businessName = trimText(input.businessName) ?? hive.name;
  const approvalPolicy = {
    ...DEFAULT_APPROVAL_POLICY,
    ...normalizeObject(input.approvalPolicy),
  };
  const autonomyPolicy = {
    ...DEFAULT_AUTONOMY_POLICY,
    ...normalizeObject(input.autonomyPolicy),
  };

  const [row] = await sql<BusinessOsProfileRow[]>`
    INSERT INTO business_os_profiles (
      hive_id,
      business_mode,
      business_name,
      industry,
      stage,
      summary,
      owner_goals,
      constraints,
      approval_policy,
      ai_spend_budget,
      autonomy_policy,
      source_profile
    ) VALUES (
      ${hiveId}::uuid,
      ${businessMode},
      ${businessName},
      ${trimText(input.industry)},
      ${trimText(input.stage)},
      ${trimText(input.summary)},
      ${sql.json(toJsonValue(normalizeTextList(input.ownerGoals)))},
      ${sql.json(toJsonValue(normalizeTextList(input.constraints)))},
      ${sql.json(toJsonValue(approvalPolicy))},
      ${sql.json(toJsonValue(normalizeObject(input.aiSpendBudget)))},
      ${sql.json(toJsonValue(autonomyPolicy))},
      ${sql.json(toJsonValue(normalizeObject(input.sourceProfile)))}
    )
    ON CONFLICT (hive_id) DO UPDATE SET
      business_mode = EXCLUDED.business_mode,
      business_name = EXCLUDED.business_name,
      industry = EXCLUDED.industry,
      stage = EXCLUDED.stage,
      summary = EXCLUDED.summary,
      owner_goals = EXCLUDED.owner_goals,
      constraints = EXCLUDED.constraints,
      approval_policy = EXCLUDED.approval_policy,
      ai_spend_budget = EXCLUDED.ai_spend_budget,
      autonomy_policy = EXCLUDED.autonomy_policy,
      source_profile = EXCLUDED.source_profile,
      updated_at = NOW()
    RETURNING
      id,
      hive_id,
      business_mode,
      business_name,
      industry,
      stage,
      summary,
      owner_goals,
      constraints,
      approval_policy,
      ai_spend_budget,
      autonomy_policy,
      source_profile
  `;

  return rowToProfile(row);
}

export async function createNewBusinessSetupState(
  sql: JsonSqlExecutor,
  hiveId: string,
  businessOsProfile: BusinessOsProfile,
  input: NewBusinessSetupInput | undefined,
  profileInput: BusinessOsProfileInput = {},
): Promise<{ setupProfileId: string; actionsCreated: number }> {
  if (businessOsProfile.businessMode !== "new_business") {
    return { setupProfileId: "", actionsCreated: 0 };
  }

  const setup = normalizeSetupInput(input, profileInput);
  const [setupProfile] = await sql<{ id: string }[]>`
    INSERT INTO business_setup_profiles (
      hive_id,
      business_os_profile_id,
      idea,
      customer_segments,
      problem_statements,
      offers,
      pricing_model,
      brand_positioning,
      sales_model,
      marketing_model,
      delivery_model,
      admin_finance_model,
      legal_compliance_checklist,
      tool_stack,
      roles_and_sops
    ) VALUES (
      ${hiveId}::uuid,
      ${businessOsProfile.id}::uuid,
      ${setup.idea as string},
      ${sql.json(toJsonValue(setup.customerSegments))},
      ${sql.json(toJsonValue(setup.problemStatements))},
      ${sql.json(toJsonValue(setup.offers))},
      ${sql.json(toJsonValue(setup.pricingModel))},
      ${sql.json(toJsonValue(setup.brandPositioning))},
      ${sql.json(toJsonValue(setup.salesModel))},
      ${sql.json(toJsonValue(setup.marketingModel))},
      ${sql.json(toJsonValue(setup.deliveryModel))},
      ${sql.json(toJsonValue(setup.adminFinanceModel))},
      ${sql.json(toJsonValue(setup.legalComplianceChecklist))},
      ${sql.json(toJsonValue(setup.toolStack))},
      ${sql.json(toJsonValue(setup.rolesAndSops))}
    )
    ON CONFLICT (hive_id) DO UPDATE SET
      business_os_profile_id = EXCLUDED.business_os_profile_id,
      idea = EXCLUDED.idea,
      customer_segments = EXCLUDED.customer_segments,
      problem_statements = EXCLUDED.problem_statements,
      offers = EXCLUDED.offers,
      pricing_model = EXCLUDED.pricing_model,
      brand_positioning = EXCLUDED.brand_positioning,
      sales_model = EXCLUDED.sales_model,
      marketing_model = EXCLUDED.marketing_model,
      delivery_model = EXCLUDED.delivery_model,
      admin_finance_model = EXCLUDED.admin_finance_model,
      legal_compliance_checklist = EXCLUDED.legal_compliance_checklist,
      tool_stack = EXCLUDED.tool_stack,
      roles_and_sops = EXCLUDED.roles_and_sops,
      updated_at = NOW()
    RETURNING id
  `;

  const evidenceRef = { source: "business_setup_profiles", id: setupProfile.id };
  return createReadinessGapsRecommendationsAndActions(sql, hiveId, businessOsProfile.id, setupProfile.id, "setup", [evidenceRef], readinessSeeds(setup), gapSeeds(setup), "medium").then((result) => ({
    setupProfileId: setupProfile.id,
    actionsCreated: result.actionsCreated,
  }));
}

async function createReadinessGapsRecommendationsAndActions(
  sql: JsonSqlExecutor,
  hiveId: string,
  businessOsProfileId: string,
  sourceId: string,
  sourceKind: BusinessSetupSourceKind,
  evidenceRefs: Array<Record<string, unknown>>,
  readiness: ReadinessSeed[],
  gaps: GapSeed[],
  defaultGapConfidence: "low" | "medium" | "high",
): Promise<{ actionsCreated: number }> {
  const readinessBySystem = new Map<string, string>();
  for (const seed of readiness) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO business_system_readiness (
        hive_id,
        business_os_profile_id,
        source_kind,
        source_id,
        system_key,
        system_label,
        readiness_score,
        maturity_level,
        confidence,
        evidence_refs,
        summary
      ) VALUES (
        ${hiveId}::uuid,
        ${businessOsProfileId}::uuid,
        ${sourceKind},
        ${sourceId}::uuid,
        ${seed.systemKey},
        ${seed.systemLabel},
        ${seed.score},
        ${seed.maturityLevel},
        ${seed.confidence},
        ${sql.json(toJsonValue(evidenceRefs))},
        ${seed.summary}
      )
      RETURNING id
    `;
    readinessBySystem.set(seed.systemKey, row.id);
  }

  let actionsCreated = 0;
  for (const seed of gaps) {
    const [gap] = await sql<{ id: string }[]>`
      INSERT INTO business_gaps (
        hive_id,
        business_os_profile_id,
        system_readiness_id,
        gap_type,
        severity,
        title,
        description,
        evidence_refs,
        confidence,
        status
      ) VALUES (
        ${hiveId}::uuid,
        ${businessOsProfileId}::uuid,
        ${readinessBySystem.get(seed.systemKey) ?? null},
        ${seed.gapType},
        ${seed.severity},
        ${seed.title},
        ${seed.description},
        ${sql.json(toJsonValue(evidenceRefs))},
        ${defaultGapConfidence},
        ${"open"}
      )
      RETURNING id
    `;
    const [recommendation] = await sql<{ id: string }[]>`
      INSERT INTO business_recommendations (
        hive_id,
        gap_id,
        recommendation_type,
        title,
        rationale,
        expected_outcome,
        estimated_effort,
        risk_level,
        requires_owner_approval,
        status
      ) VALUES (
        ${hiveId}::uuid,
        ${gap.id}::uuid,
        ${seed.recommendationType},
        ${seed.recommendationTitle},
        ${seed.rationale},
        ${seed.expectedOutcome},
        ${"small"},
        ${seed.riskLevel},
        ${seed.approvalRequired},
        ${"converted_to_action"}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO business_actions (
        hive_id,
        business_os_profile_id,
        recommendation_id,
        system_key,
        action_type,
        title,
        brief,
        status,
        priority,
        risk_level,
        approval_required,
        source_refs,
        expected_outcome,
        measurement_plan
      ) VALUES (
        ${hiveId}::uuid,
        ${businessOsProfileId}::uuid,
        ${recommendation.id}::uuid,
        ${seed.systemKey},
        ${seed.actionType},
        ${seed.actionTitle},
        ${seed.actionBrief},
        ${seed.actionStatus},
        ${seed.priority},
        ${seed.riskLevel},
        ${seed.approvalRequired},
        ${sql.json(toJsonValue([...evidenceRefs, { source: "business_recommendations", id: recommendation.id }]))},
        ${seed.expectedOutcome},
        ${sql.json(toJsonValue(seed.measurementPlan))}
      )
    `;
    actionsCreated += 1;
  }

  return { actionsCreated };
}

export async function createExistingBusinessAuditState(
  sql: JsonSqlExecutor,
  hiveId: string,
  businessOsProfile: BusinessOsProfile,
  input: ExistingBusinessAuditInput | undefined,
): Promise<{ auditProfileId: string; actionsCreated: number }> {
  if (businessOsProfile.businessMode !== "existing_business") {
    return { auditProfileId: "", actionsCreated: 0 };
  }

  const audit = normalizeAuditInput(input);
  const readiness = auditReadinessSeeds(audit);
  const overallReadinessScore = Math.round(readiness.reduce((total, row) => total + row.score, 0) / readiness.length);
  const overallConfidence = audit.evidenceSources.length >= 2 ? "medium" : "low";
  const [auditProfile] = await sql<{ id: string }[]>`
    INSERT INTO business_audit_profiles (
      hive_id,
      business_os_profile_id,
      audit_status,
      audit_scope,
      evidence_sources,
      known_unknowns,
      overall_readiness_score,
      overall_confidence,
      completed_at
    ) VALUES (
      ${hiveId}::uuid,
      ${businessOsProfile.id}::uuid,
      ${"completed"},
      ${sql.json(toJsonValue(audit.scope))},
      ${sql.json(toJsonValue(audit.evidenceSources))},
      ${sql.json(toJsonValue(audit.knownUnknowns))},
      ${overallReadinessScore},
      ${overallConfidence},
      NOW()
    )
    ON CONFLICT (hive_id) DO UPDATE SET
      business_os_profile_id = EXCLUDED.business_os_profile_id,
      audit_status = EXCLUDED.audit_status,
      audit_scope = EXCLUDED.audit_scope,
      evidence_sources = EXCLUDED.evidence_sources,
      known_unknowns = EXCLUDED.known_unknowns,
      overall_readiness_score = EXCLUDED.overall_readiness_score,
      overall_confidence = EXCLUDED.overall_confidence,
      completed_at = EXCLUDED.completed_at,
      updated_at = NOW()
    RETURNING id
  `;

  const evidenceRefs = [
    { source: "business_audit_profiles", id: auditProfile.id },
    ...audit.evidenceSources.map((source, index) => ({ source: "audit_evidence_source", index, label: source.label ?? source.kind ?? "evidence" })),
  ];
  const result = await createReadinessGapsRecommendationsAndActions(
    sql,
    hiveId,
    businessOsProfile.id,
    auditProfile.id,
    "audit",
    evidenceRefs,
    readiness,
    auditGapSeeds(),
    overallConfidence,
  );

  return { auditProfileId: auditProfile.id, actionsCreated: result.actionsCreated };
}
