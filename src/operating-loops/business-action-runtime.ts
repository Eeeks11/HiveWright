import type { Sql } from "postgres";

export type BusinessActionRiskLevel = "low" | "medium" | "high";
export type BusinessActionStatus =
  | "draft"
  | "queued"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type BusinessActionMeasurement = {
  measuredAt: string;
  summary: string;
  metricName: string;
  baseline?: number | string | null;
  current?: number | string | null;
  target?: number | string | null;
  confidence: "low" | "medium" | "high";
  evidenceRefs: Array<Record<string, unknown>>;
  readinessScore?: number | null;
  nextRecommendation?: string | null;
};

export type BusinessActionMeasurementPlan = {
  metricName: string;
  target?: number | string | null;
  baseline?: number | string | null;
  cadence: "once" | "daily" | "weekly" | "monthly";
  status: "planned" | "measuring" | "measured";
  loopStage: "plan" | "execute" | "measure" | "optimise";
  measurements: BusinessActionMeasurement[];
  approval?: {
    required: boolean;
    decisionId: string | null;
    status: "not_required" | "awaiting_owner" | "approved" | "rejected";
  };
};

export type RecommendationActionInput = {
  recommendationId: string;
  businessOsProfileId: string;
  assignedRoleSlug?: string | null;
  systemKey?: string | null;
  actionType?: string | null;
  priority?: number;
  measurement?: Partial<Pick<BusinessActionMeasurementPlan, "metricName" | "target" | "baseline" | "cadence">>;
};

export type BusinessActionRuntimeRow = {
  id: string;
  hive_id: string;
  business_os_profile_id: string;
  recommendation_id: string | null;
  title: string;
  brief: string;
  status: BusinessActionStatus;
  approval_required: boolean;
  risk_level: BusinessActionRiskLevel | null;
  decision_id: string | null;
  measurement_plan: BusinessActionMeasurementPlan;
};

type RecommendationRow = {
  id: string;
  hive_id: string;
  title: string;
  rationale: string;
  expected_outcome: string | null;
  risk_level: BusinessActionRiskLevel | null;
  requires_owner_approval: boolean;
  status: string;
};

type BusinessProfileRow = {
  id: string;
  hive_id: string;
  business_name: string;
  approval_policy: Record<string, unknown>;
  autonomy_policy: Record<string, unknown>;
};

const SENSITIVE_ACTION_RE =
  /\b(send|publish|post|email|message|call|book|cancel|pay|spend|purchase|refund|contract|quote|invoice|discount|customer|vendor|public|external)\b/i;

type SqlJsonValue = Parameters<Sql["json"]>[0];

function toSqlJson(value: unknown): SqlJsonValue {
  return value as SqlJsonValue;
}

function requireSingleRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label} not found`);
  return row;
}

function isHighRisk(riskLevel: BusinessActionRiskLevel | null): boolean {
  return riskLevel === "medium" || riskLevel === "high";
}

function actionNeedsOwnerApproval(recommendation: RecommendationRow): boolean {
  return (
    recommendation.requires_owner_approval ||
    isHighRisk(recommendation.risk_level) ||
    SENSITIVE_ACTION_RE.test(`${recommendation.title}\n${recommendation.rationale}\n${recommendation.expected_outcome ?? ""}`)
  );
}

function buildMeasurementPlan(
  input: RecommendationActionInput,
  approvalRequired: boolean,
): BusinessActionMeasurementPlan {
  return {
    metricName: input.measurement?.metricName ?? "owner-visible business outcome movement",
    target: input.measurement?.target ?? null,
    baseline: input.measurement?.baseline ?? null,
    cadence: input.measurement?.cadence ?? "weekly",
    status: "planned",
    loopStage: "plan",
    measurements: [],
    approval: {
      required: approvalRequired,
      decisionId: null,
      status: approvalRequired ? "awaiting_owner" : "not_required",
    },
  };
}

export async function convertRecommendationToBusinessAction(
  sql: Sql,
  input: RecommendationActionInput,
): Promise<BusinessActionRuntimeRow> {
  return sql.begin(async (tx) => {
    const recommendation = requireSingleRow(
      await tx<RecommendationRow[]>`
        SELECT id, hive_id, title, rationale, expected_outcome, risk_level, requires_owner_approval, status
        FROM business_recommendations
        WHERE id = ${input.recommendationId}::uuid
        FOR UPDATE
      `,
      "business recommendation",
    );

    if (!["proposed", "accepted"].includes(recommendation.status)) {
      throw new Error(`business recommendation ${recommendation.id} is not convertible from status ${recommendation.status}`);
    }

    const profile = requireSingleRow(
      await tx<BusinessProfileRow[]>`
        SELECT id, hive_id, business_name, approval_policy, autonomy_policy
        FROM business_os_profiles
        WHERE id = ${input.businessOsProfileId}::uuid
          AND hive_id = ${recommendation.hive_id}::uuid
        FOR UPDATE
      `,
      "business OS profile",
    );

    const approvalRequired = actionNeedsOwnerApproval(recommendation);
    const status: BusinessActionStatus = approvalRequired ? "awaiting_approval" : "queued";
    const measurementPlan = buildMeasurementPlan(input, approvalRequired);

    const [action] = await tx<BusinessActionRuntimeRow[]>`
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
        assigned_role_slug,
        source_refs,
        expected_outcome,
        measurement_plan
      )
      VALUES (
        ${recommendation.hive_id}::uuid,
        ${profile.id}::uuid,
        ${recommendation.id}::uuid,
        ${input.systemKey ?? null},
        ${input.actionType ?? "business_os_recommendation"},
        ${recommendation.title},
        ${recommendation.rationale},
        ${status},
        ${input.priority ?? 50},
        ${recommendation.risk_level},
        ${approvalRequired},
        ${input.assignedRoleSlug ?? null},
        ${tx.json(toSqlJson([{ kind: "business_recommendation", id: recommendation.id }]))},
        ${recommendation.expected_outcome},
        ${tx.json(toSqlJson(measurementPlan))}
      )
      RETURNING id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
                risk_level, decision_id, measurement_plan
    `;

    await tx`
      UPDATE business_recommendations
      SET status = 'converted_to_action', updated_at = now()
      WHERE id = ${recommendation.id}::uuid
    `;

    if (!approvalRequired) return action;

    const [decision] = await tx<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id,
        title,
        context,
        recommendation,
        options,
        priority,
        status,
        kind,
        route_metadata,
        ea_reasoning
      )
      VALUES (
        ${recommendation.hive_id}::uuid,
        ${`Approve Business OS action: ${recommendation.title}`},
        ${[
          `${profile.business_name} has a Business OS action ready to execute from a structured recommendation.`,
          `Action brief: ${recommendation.rationale}`,
          `Expected outcome: ${recommendation.expected_outcome ?? "not specified"}`,
          "No public, spend-sensitive, external, customer/vendor, or commitment-making work should run until this is approved.",
        ].join("\n\n")},
        ${"Approve only if this action is within the owner's current controlled-autonomy boundary."},
        ${tx.json(toSqlJson([
          {
            key: "approve",
            label: "Approve action",
            consequence: "The action can move from awaiting approval to approved/queued execution.",
            response: "approved",
          },
          {
            key: "reject",
            label: "Reject or revise",
            consequence: "The action remains blocked and must be revised or cancelled.",
            response: "rejected",
          },
        ]))},
        ${isHighRisk(recommendation.risk_level) ? "high" : "normal"},
        ${"pending"},
        ${"business_os_action_approval"},
        ${tx.json(toSqlJson({
          workflow: "business_os_action_loop",
          actionId: action.id,
          recommendationId: recommendation.id,
          approvalRequired: true,
          riskLevel: recommendation.risk_level,
        }))},
        ${"Business OS action loop escalated this action because execution is owner-approval-gated."}
      )
      RETURNING id
    `;

    const approvedPlan: BusinessActionMeasurementPlan = {
      ...measurementPlan,
      approval: { required: true, decisionId: decision.id, status: "awaiting_owner" },
    };

    const [updatedAction] = await tx<BusinessActionRuntimeRow[]>`
      UPDATE business_actions
      SET decision_id = ${decision.id}::uuid,
          measurement_plan = ${tx.json(toSqlJson(approvedPlan))},
          updated_at = now()
      WHERE id = ${action.id}::uuid
      RETURNING id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
                risk_level, decision_id, measurement_plan
    `;

    return updatedAction;
  });
}

export async function resolveBusinessActionApproval(
  sql: Sql,
  input: { actionId: string; approved: boolean; resolvedBy: string; ownerResponse?: string | null },
): Promise<BusinessActionRuntimeRow> {
  return sql.begin(async (tx) => {
    const action = requireSingleRow(
      await tx<BusinessActionRuntimeRow[]>`
        SELECT id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
               risk_level, decision_id, measurement_plan
        FROM business_actions
        WHERE id = ${input.actionId}::uuid
        FOR UPDATE
      `,
      "business action",
    );

    if (!action.approval_required) return action;
    if (!action.decision_id) throw new Error(`business action ${action.id} has no approval decision`);

    const nextStatus: BusinessActionStatus = input.approved ? "approved" : "cancelled";
    const approvalStatus = input.approved ? "approved" : "rejected";
    const measurementPlan: BusinessActionMeasurementPlan = {
      ...action.measurement_plan,
      loopStage: input.approved ? "execute" : action.measurement_plan.loopStage,
      approval: {
        required: true,
        decisionId: action.decision_id,
        status: approvalStatus,
      },
    };

    await tx`
      UPDATE decisions
      SET status = 'resolved',
          owner_response = ${input.ownerResponse ?? (input.approved ? "Approved" : "Rejected")},
          selected_option_key = ${input.approved ? "approve" : "reject"},
          selected_option_label = ${input.approved ? "Approve action" : "Reject or revise"},
          resolved_by = ${input.resolvedBy},
          resolved_at = now()
      WHERE id = ${action.decision_id}::uuid
    `;

    const [updatedAction] = await tx<BusinessActionRuntimeRow[]>`
      UPDATE business_actions
      SET status = ${nextStatus},
          measurement_plan = ${tx.json(toSqlJson(measurementPlan))},
          updated_at = now()
      WHERE id = ${action.id}::uuid
      RETURNING id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
                risk_level, decision_id, measurement_plan
    `;

    return updatedAction;
  });
}

export async function startApprovedBusinessAction(
  sql: Sql,
  actionId: string,
): Promise<BusinessActionRuntimeRow> {
  const [updatedAction] = await sql<BusinessActionRuntimeRow[]>`
    UPDATE business_actions
    SET status = 'running',
        measurement_plan = jsonb_set(measurement_plan, '{loopStage}', '"execute"'::jsonb, true),
        updated_at = now()
    WHERE id = ${actionId}::uuid
      AND status IN ('queued', 'approved')
    RETURNING id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
              risk_level, decision_id, measurement_plan
  `;

  if (!updatedAction) throw new Error(`business action ${actionId} is not queued or approved`);
  return updatedAction;
}

export async function recordBusinessActionMeasurement(
  sql: Sql,
  input: { actionId: string; measurement: BusinessActionMeasurement },
): Promise<BusinessActionRuntimeRow> {
  return sql.begin(async (tx) => {
    const action = requireSingleRow(
      await tx<(BusinessActionRuntimeRow & { system_key: string | null })[]>`
        SELECT id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
               risk_level, decision_id, measurement_plan, system_key
        FROM business_actions
        WHERE id = ${input.actionId}::uuid
        FOR UPDATE
      `,
      "business action",
    );

    if (!["running", "approved", "queued"].includes(action.status)) {
      throw new Error(`business action ${action.id} cannot be measured from status ${action.status}`);
    }

    const measurements = [...(action.measurement_plan.measurements ?? []), input.measurement];
    const measurementPlan: BusinessActionMeasurementPlan = {
      ...action.measurement_plan,
      status: "measured",
      loopStage: input.measurement.nextRecommendation ? "optimise" : "measure",
      measurements,
    };

    if (action.system_key && input.measurement.readinessScore !== undefined && input.measurement.readinessScore !== null) {
      await tx`
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
          summary,
          updated_at
        )
        VALUES (
          ${action.hive_id}::uuid,
          ${action.business_os_profile_id}::uuid,
          'loop_measurement',
          ${action.id}::uuid,
          ${action.system_key},
          ${action.system_key.replace(/[-_]/g, " ")},
          ${input.measurement.readinessScore},
          ${maturityFromReadiness(input.measurement.readinessScore)},
          ${input.measurement.confidence},
          ${tx.json(toSqlJson(input.measurement.evidenceRefs))},
          ${input.measurement.summary},
          now()
        )
      `;
    }

    const [updatedAction] = await tx<BusinessActionRuntimeRow[]>`
      UPDATE business_actions
      SET status = 'completed',
          completed_at = now(),
          measurement_plan = ${tx.json(toSqlJson(measurementPlan))},
          updated_at = now()
      WHERE id = ${action.id}::uuid
      RETURNING id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
                risk_level, decision_id, measurement_plan
    `;

    return updatedAction;
  });
}

function maturityFromReadiness(score: number): "missing" | "ad_hoc" | "defined" | "managed" | "optimising" {
  if (score < 20) return "missing";
  if (score < 45) return "ad_hoc";
  if (score < 70) return "defined";
  if (score < 90) return "managed";
  return "optimising";
}
