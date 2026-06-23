import type { JSONValue, Sql, TransactionSql } from "postgres";
import { buildBusinessSystemTemplateOutputs } from "@/business-os/system-templates";

export const BUSINESS_MODES = ["new_business", "existing_business"] as const;

export type BusinessMode = typeof BUSINESS_MODES[number];

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
  customerSegments?: unknown;
  problemStatements?: unknown;
  offers?: unknown;
  pricingModel?: unknown;
  brandPositioning?: unknown;
  salesModel?: unknown;
  marketingModel?: unknown;
  deliveryModel?: unknown;
  adminFinanceModel?: unknown;
  legalComplianceChecklist?: unknown;
  toolStack?: unknown;
  rolesAndSops?: unknown;
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
  return {
    idea,
    customerSegments: normalizeTextList(input?.customerSegments),
    problemStatements: normalizeTextList(input?.problemStatements),
    offers: normalizeTextList(input?.offers),
    pricingModel: normalizeObject(input?.pricingModel),
    brandPositioning: normalizeObject(input?.brandPositioning),
    salesModel: normalizeObject(input?.salesModel),
    marketingModel: normalizeObject(input?.marketingModel),
    deliveryModel: normalizeObject(input?.deliveryModel),
    adminFinanceModel: normalizeObject(input?.adminFinanceModel),
    legalComplianceChecklist: normalizeTextList(input?.legalComplianceChecklist),
    toolStack: normalizeTextList(input?.toolStack),
    rolesAndSops: normalizeTextList(input?.rolesAndSops),
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
  const readinessBySystem = new Map<string, string>();
  for (const seed of readinessSeeds(setup)) {
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
        ${businessOsProfile.id}::uuid,
        ${"setup"},
        ${setupProfile.id}::uuid,
        ${seed.systemKey},
        ${seed.systemLabel},
        ${seed.score},
        ${seed.maturityLevel},
        ${seed.confidence},
        ${sql.json(toJsonValue([evidenceRef]))},
        ${seed.summary}
      )
      RETURNING id
    `;
    readinessBySystem.set(seed.systemKey, row.id);
  }

  let actionsCreated = 0;
  for (const seed of gapSeeds(setup)) {
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
        ${businessOsProfile.id}::uuid,
        ${readinessBySystem.get(seed.systemKey) ?? null},
        ${seed.gapType},
        ${seed.severity},
        ${seed.title},
        ${seed.description},
        ${sql.json(toJsonValue([evidenceRef]))},
        ${"medium"},
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
        ${businessOsProfile.id}::uuid,
        ${recommendation.id}::uuid,
        ${seed.systemKey},
        ${seed.actionType},
        ${seed.actionTitle},
        ${seed.actionBrief},
        ${seed.actionStatus},
        ${seed.priority},
        ${seed.riskLevel},
        ${seed.approvalRequired},
        ${sql.json(toJsonValue([evidenceRef, { source: "business_recommendations", id: recommendation.id }]))},
        ${seed.expectedOutcome},
        ${sql.json(toJsonValue(seed.measurementPlan))}
      )
    `;
    actionsCreated += 1;
  }

  return { setupProfileId: setupProfile.id, actionsCreated };
}
