import { buildBusinessOsDiagnosticExport, type DiagnosticVariant } from "@/business-os/diagnostic-export";
import { deriveBusinessOsOwnerDashboard, type BusinessOsModuleSnapshot } from "@/business-os/owner-dashboard";
import { canAccessHive } from "@/auth/users";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BusinessProfileRow = {
  id: string;
  business_mode: "new_business" | "existing_business";
  business_name: string;
  stage: string | null;
  summary: string | null;
  owner_goals: string[];
  approval_policy: Record<string, unknown>;
  ai_spend_budget: Record<string, unknown>;
  autonomy_policy: Record<string, unknown>;
  updated_at: Date | string | null;
};

type SetupProfileRow = {
  idea: string | null;
  customer_segments: string[];
  offers: string[];
  legal_compliance_checklist: string[];
  tool_stack: string[];
  roles_and_sops: string[];
  updated_at: Date | string | null;
};

type AuditProfileRow = {
  audit_status: string;
  overall_readiness_score: number | null;
  overall_confidence: string | null;
  audit_scope: string[];
  evidence_sources: Array<Record<string, unknown>>;
  known_unknowns: string[];
  completed_at: Date | string | null;
  updated_at: Date | string | null;
};

type ReadinessRow = {
  system_key: string;
  system_label: string;
  readiness_score: number;
  maturity_level: string | null;
  confidence: string | null;
  evidence_refs: Array<Record<string, unknown>>;
  summary: string | null;
  updated_at: Date | string | null;
};

type GapRow = {
  title: string;
  severity: string | null;
  status: string;
  system_key: string | null;
  confidence: string | null;
  evidence_refs: Array<Record<string, unknown>>;
};

type RecommendationRow = {
  title: string;
  rationale: string;
  expected_outcome: string | null;
  risk_level: string | null;
  requires_owner_approval: boolean;
  status: string;
  created_at: Date | string | null;
  updated_at: Date | string | null;
};

type ActionRow = {
  id: string;
  system_key: string | null;
  title: string;
  brief: string;
  status: string;
  priority: number;
  risk_level: string | null;
  approval_required: boolean;
  expected_outcome: string | null;
  measurement_plan: Record<string, unknown>;
  source_refs: Array<Record<string, unknown>>;
  created_at: Date | string | null;
  updated_at: Date | string | null;
};

type ActivityRow = {
  title: string;
  summary: string | null;
  status: string;
  role: string | null;
  evidence_url: string | null;
  updated_at: Date | string | null;
};

type MarketingModuleRow = {
  campaign_count: number | string | null;
  metric_count: number | string | null;
  connected_systems: string[] | null;
  latest_activity_at: Date | string | null;
};

type SalesModuleRow = {
  funnel_count: number | string | null;
  action_plan_count: number | string | null;
  connected_systems: string[] | null;
  latest_activity_at: Date | string | null;
};

function arr<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function obj(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function plural(countValue: number, singular: string, pluralLabel = `${singular}s`) {
  return `${countValue} ${countValue === 1 ? singular : pluralLabel}`;
}

function moduleReviewAt(value: Date | string | null | undefined, hasModuleData: boolean) {
  if (!hasModuleData || !value || asTime(value) <= 0) return null;
  return value;
}

function asTime(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function buildModuleSnapshots(hiveId: string, marketingRow: MarketingModuleRow | undefined, salesRow: SalesModuleRow | undefined): BusinessOsModuleSnapshot[] {
  const marketingCampaigns = count(marketingRow?.campaign_count);
  const marketingMetrics = count(marketingRow?.metric_count);
  const salesFunnels = count(salesRow?.funnel_count);
  const salesPlans = count(salesRow?.action_plan_count);
  const marketingSystems = arr(marketingRow?.connected_systems);
  const salesSystems = arr(salesRow?.connected_systems);
  const hasMarketingData = marketingCampaigns > 0 || marketingMetrics > 0 || marketingSystems.length > 0;
  const hasSalesData = salesFunnels > 0 || salesPlans > 0 || salesSystems.length > 0;

  return [
    {
      key: "revenue_marketing",
      href: `/marketing?hiveId=${hiveId}`,
      summary: hasMarketingData ? `${plural(marketingCampaigns, "campaign")}, ${plural(marketingMetrics, "metric snapshot")}.` : null,
      connectedSystems: marketingSystems,
      evidenceRefs: marketingCampaigns || marketingMetrics ? [{ label: "Marketing dashboard" }] : [],
      nextReviewAt: moduleReviewAt(marketingRow?.latest_activity_at, hasMarketingData),
    },
    {
      key: "revenue_sales",
      href: `/sales?hiveId=${hiveId}`,
      summary: hasSalesData ? `${plural(salesFunnels, "funnel")}, ${plural(salesPlans, "action plan")}.` : null,
      connectedSystems: salesSystems,
      evidenceRefs: salesFunnels || salesPlans ? [{ label: "Sales dashboard" }] : [],
      nextReviewAt: moduleReviewAt(salesRow?.latest_activity_at, hasSalesData),
    },
  ];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!id) return jsonError("id is required", 400);
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) return jsonError("Forbidden: hive access required", 403);
  }

  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  const diagnosticVariantParam = url.searchParams.get("diagnosticExport");
  if (diagnosticVariantParam === "internal" && !authz.user.isSystemOwner) {
    return jsonError("Forbidden: internal diagnostic export requires system owner access", 403);
  }
  const diagnosticVariant: DiagnosticVariant | null = diagnosticVariantParam === "client_safe" || diagnosticVariantParam === "internal"
    ? diagnosticVariantParam
    : null;

  const [profile] = await sql<BusinessProfileRow[]>`
    SELECT id, business_mode, business_name, stage, summary, owner_goals, approval_policy,
           ai_spend_budget, autonomy_policy, updated_at
    FROM business_os_profiles
    WHERE hive_id = ${id}::uuid
  `;

  if (!profile) {
    const [hive] = await sql<{ id: string; name: string; kind: string; description: string | null }[]>`
      SELECT id, name, kind, description
      FROM hives
      WHERE id = ${id}::uuid
    `;
    if (!hive || hive.kind !== "business") {
      return jsonError("Business OS profile not found for hive", 404);
    }
    return jsonOk({
      status: "setup_required",
      headline: `${hive.name} Business OS setup required`,
      summary: hive.description,
      setupRequired: {
        label: "Set up or audit this business",
        href: `/hives/${id}/business-os/setup`,
        description: "Create a Business OS profile before treating this hive as operationally visible.",
      },
    });
  }

  const [setupProfile] = await sql<SetupProfileRow[]>`
    SELECT idea, customer_segments, offers, legal_compliance_checklist, tool_stack, roles_and_sops, updated_at
    FROM business_setup_profiles
    WHERE hive_id = ${id}::uuid
  `;
  const [auditProfile] = await sql<AuditProfileRow[]>`
    SELECT audit_status, overall_readiness_score, overall_confidence, audit_scope, evidence_sources,
           known_unknowns, completed_at, updated_at
    FROM business_audit_profiles
    WHERE hive_id = ${id}::uuid
  `;
  const readiness = await sql<ReadinessRow[]>`
    SELECT system_key, system_label, readiness_score, maturity_level, confidence, evidence_refs, summary, updated_at
    FROM business_system_readiness
    WHERE hive_id = ${id}::uuid
    ORDER BY readiness_score ASC, system_label ASC
  `;
  const gaps = await sql<GapRow[]>`
    SELECT bg.title, bg.severity, bg.status, bsr.system_key, bg.confidence, bg.evidence_refs
    FROM business_gaps bg
    LEFT JOIN business_system_readiness bsr ON bsr.id = bg.system_readiness_id
    WHERE bg.hive_id = ${id}::uuid
    ORDER BY CASE bg.severity
      WHEN 'critical' THEN 4
      WHEN 'high' THEN 3
      WHEN 'medium' THEN 2
      WHEN 'low' THEN 1
      ELSE 0
    END DESC, bg.updated_at DESC
    LIMIT 20
  `;
  const recommendations = await sql<RecommendationRow[]>`
    SELECT title, rationale, expected_outcome, risk_level, requires_owner_approval, status, created_at, updated_at
    FROM business_recommendations
    WHERE hive_id = ${id}::uuid
    ORDER BY updated_at DESC
    LIMIT 20
  `;
  const actions = await sql<ActionRow[]>`
    SELECT id, system_key, title, brief, status, priority, risk_level, approval_required, expected_outcome,
           measurement_plan, source_refs, created_at, updated_at
    FROM business_actions
    WHERE hive_id = ${id}::uuid
    ORDER BY priority DESC, updated_at DESC
    LIMIT 50
  `;
  const agentActivity = await sql<ActivityRow[]>`
    SELECT t.title,
           t.result_summary AS summary,
           t.status,
           t.assigned_to AS role,
           CASE WHEN wp.id IS NOT NULL THEN '/deliverables/' || wp.id::text ELSE NULL END AS evidence_url,
           t.updated_at
    FROM tasks t
    LEFT JOIN LATERAL (
      SELECT id
      FROM work_products
      WHERE task_id = t.id
      ORDER BY created_at DESC
      LIMIT 1
    ) wp ON TRUE
    WHERE t.hive_id = ${id}::uuid
      AND t.status IN ('completed', 'in_review', 'active', 'blocked')
    ORDER BY t.updated_at DESC
    LIMIT 10
  `;
  const [marketingModule] = await sql<MarketingModuleRow[]>`
    SELECT
      (SELECT count(*) FROM marketing_campaigns WHERE hive_id = ${id}::uuid) AS campaign_count,
      (SELECT count(*) FROM marketing_metric_snapshots WHERE hive_id = ${id}::uuid) AS metric_count,
      COALESCE((
        SELECT array_agg(display_name ORDER BY display_name)
        FROM connector_installs
        WHERE hive_id = ${id}::uuid
          AND connector_slug IN ('google-analytics-4', 'google-search-console', 'website-forms', 'google-business-profile', 'email-platform', 'google-ads', 'meta-ads')
      ), ARRAY[]::text[]) AS connected_systems,
      GREATEST(
        COALESCE((SELECT max(created_at) FROM marketing_campaigns WHERE hive_id = ${id}::uuid), 'epoch'::timestamp),
        COALESCE((SELECT max(captured_at) FROM marketing_metric_snapshots WHERE hive_id = ${id}::uuid), 'epoch'::timestamp),
        COALESCE((SELECT max(last_tested_at) FROM connector_installs WHERE hive_id = ${id}::uuid), 'epoch'::timestamp)
      ) AS latest_activity_at
  `;
  const [salesModule] = await sql<SalesModuleRow[]>`
    SELECT
      (SELECT count(*) FROM sales_funnels WHERE hive_id = ${id}::uuid) AS funnel_count,
      (SELECT count(*) FROM sales_action_plans WHERE hive_id = ${id}::uuid) AS action_plan_count,
      COALESCE((
        SELECT array_agg(display_name ORDER BY display_name)
        FROM connector_installs
        WHERE hive_id = ${id}::uuid
          AND connector_slug IN ('website-forms', 'email-platform', 'crm', 'booking', 'phone-call-tracking', 'google-business-profile')
      ), ARRAY[]::text[]) AS connected_systems,
      GREATEST(
        COALESCE((SELECT max(captured_at) FROM sales_funnels WHERE hive_id = ${id}::uuid), 'epoch'::timestamp),
        COALESCE((SELECT max(created_at) FROM sales_action_plans WHERE hive_id = ${id}::uuid), 'epoch'::timestamp),
        COALESCE((SELECT max(last_tested_at) FROM connector_installs WHERE hive_id = ${id}::uuid), 'epoch'::timestamp)
      ) AS latest_activity_at
  `;

  const dashboard = deriveBusinessOsOwnerDashboard({
    hiveId: id,
    profile: {
      id: profile.id,
      businessMode: profile.business_mode,
      businessName: profile.business_name,
      stage: profile.stage,
      summary: profile.summary,
      ownerGoals: arr(profile.owner_goals),
      approvalPolicy: obj(profile.approval_policy),
      aiSpendBudget: obj(profile.ai_spend_budget),
      autonomyPolicy: obj(profile.autonomy_policy),
      updatedAt: profile.updated_at,
    },
    setupProfile: setupProfile ? {
      idea: setupProfile.idea,
      customerSegments: arr(setupProfile.customer_segments),
      offers: arr(setupProfile.offers),
      legalComplianceChecklist: arr(setupProfile.legal_compliance_checklist),
      toolStack: arr(setupProfile.tool_stack),
      rolesAndSops: arr(setupProfile.roles_and_sops),
      updatedAt: setupProfile.updated_at,
    } : null,
    auditProfile: auditProfile ? {
      auditStatus: auditProfile.audit_status,
      overallReadinessScore: auditProfile.overall_readiness_score,
      overallConfidence: auditProfile.overall_confidence,
      auditScope: arr(auditProfile.audit_scope),
      evidenceSources: arr(auditProfile.evidence_sources),
      knownUnknowns: arr(auditProfile.known_unknowns),
      completedAt: auditProfile.completed_at,
      updatedAt: auditProfile.updated_at,
    } : null,
    readiness: readiness.map((row) => ({
      systemKey: row.system_key,
      systemLabel: row.system_label,
      readinessScore: Number(row.readiness_score),
      maturityLevel: row.maturity_level,
      confidence: row.confidence,
      evidenceRefs: arr(row.evidence_refs),
      summary: row.summary,
      updatedAt: row.updated_at,
    })),
    gaps: gaps.map((row) => ({
      title: row.title,
      severity: row.severity,
      status: row.status,
      systemKey: row.system_key,
      confidence: row.confidence,
      evidenceRefs: arr(row.evidence_refs),
    })),
    recommendations: recommendations.map((row) => ({
      title: row.title,
      rationale: row.rationale,
      expectedOutcome: row.expected_outcome,
      riskLevel: row.risk_level,
      requiresOwnerApproval: row.requires_owner_approval,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    actions: actions.map((row) => ({
      id: row.id,
      systemKey: row.system_key,
      title: row.title,
      brief: row.brief,
      status: row.status,
      priority: Number(row.priority),
      riskLevel: row.risk_level,
      approvalRequired: row.approval_required,
      expectedOutcome: row.expected_outcome,
      measurementPlan: obj(row.measurement_plan),
      sourceRefs: arr(row.source_refs),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    agentActivity: agentActivity.map((row) => ({
      title: row.title,
      summary: row.summary,
      status: row.status,
      role: row.role,
      evidenceUrl: row.evidence_url,
      updatedAt: row.updated_at,
    })),
    moduleSnapshots: buildModuleSnapshots(id, marketingModule, salesModule),
    since,
  });

  return jsonOk({
    ...dashboard,
    ...(diagnosticVariant ? {
      diagnosticExport: buildBusinessOsDiagnosticExport({
        dashboard,
        variant: diagnosticVariant,
      }),
    } : {}),
  });
}
