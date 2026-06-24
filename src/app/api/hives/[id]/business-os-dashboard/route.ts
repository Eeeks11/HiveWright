import { deriveBusinessOsOwnerDashboard } from "@/business-os/owner-dashboard";
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

function arr<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function obj(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

  const [profile] = await sql<BusinessProfileRow[]>`
    SELECT id, business_mode, business_name, stage, summary, owner_goals, approval_policy,
           ai_spend_budget, autonomy_policy, updated_at
    FROM business_os_profiles
    WHERE hive_id = ${id}::uuid
  `;

  if (!profile) {
    return jsonError("Business OS profile not found for hive", 404);
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
    SELECT title, brief, status, priority, risk_level, approval_required, expected_outcome,
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

  const dashboard = deriveBusinessOsOwnerDashboard({
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
    since,
  });

  return jsonOk(dashboard);
}
