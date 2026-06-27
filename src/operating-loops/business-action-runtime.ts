import type { Sql, TransactionSql } from "postgres";

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

export type BusinessActionRiskCategory =
  | "internal_low_risk"
  | "medium_business_risk"
  | "high_business_risk"
  | "public_action"
  | "spend_sensitive"
  | "external_message"
  | "customer_or_vendor_touchpoint"
  | "commitment_or_destructive_change"
  | "legal_finance_or_compliance";

export type BusinessActionApprovalGate = {
  category: BusinessActionRiskCategory;
  required: boolean;
  reason: string;
};

export type BusinessActionGovernanceAssessment = {
  posture: "shadow_mode" | "supervised" | "controlled_autonomy";
  riskCategories: BusinessActionRiskCategory[];
  approvalRequired: boolean;
  approvalGates: BusinessActionApprovalGate[];
  evidenceRequirements: string[];
  rollbackRequirement: string;
  escalation: {
    required: boolean;
    priority: "normal" | "high";
    reason: string | null;
  };
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
  governance: BusinessActionGovernanceAssessment;
  conversions?: {
    agentTaskId?: string;
    scheduleId?: string;
    sopTaskId?: string;
    sopWorkProductId?: string;
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

const PUBLIC_ACTION_RE = /\b(publish|post|advertise|ad\b|social|website|landing page|public|press|review response)\b/i;
const SPEND_ACTION_RE = /\b(pay|spend|purchase|buy|budget|ad spend|refund|discount|invoice|quote|subscription|hire|contract)\b/i;
const EXTERNAL_MESSAGE_RE = /\b(send|email|message|sms|call|dm|reply|outreach|follow[- ]?up|contact|book)\b/i;
const CUSTOMER_VENDOR_RE = /\b(customer|client|lead|prospect|vendor|supplier|partner|contractor)\b/i;
const COMMITMENT_OR_DESTRUCTIVE_RE = /\b(cancel|delete|remove|terminate|commit|sign|contract|change pricing|go live|launch)\b/i;
const LEGAL_FINANCE_COMPLIANCE_RE =
  /\b(legal|compliance|tax|finance|financial|payroll|accounting|privacy|policy|terms|bas|gst|payg|ato|xero|myob|quickbooks|bookkeep(?:ing|er)?|invoice|invoicing|receipt|superannuation|super|wages?|salary|salaries|bank(?:ing)?|reconcile|reconciliation|lodg(?:e|ed|ing|ement)|lodgement)\b/i;

type SqlJsonValue = Parameters<Sql["json"]>[0];

function toSqlJson(value: unknown): SqlJsonValue {
  return value as SqlJsonValue;
}

function requireSingleRow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label} not found`);
  return row;
}

function addCategory(categories: Set<BusinessActionRiskCategory>, category: BusinessActionRiskCategory, matches: boolean): void {
  if (matches) categories.add(category);
}

function readPolicyPosture(policy: Record<string, unknown>): BusinessActionGovernanceAssessment["posture"] {
  return policy.posture === "controlled_autonomy" || policy.posture === "shadow_mode" || policy.posture === "supervised"
    ? policy.posture
    : "supervised";
}

function assessBusinessActionGovernance(
  recommendation: RecommendationRow,
  profile: Pick<BusinessProfileRow, "approval_policy" | "autonomy_policy">,
): BusinessActionGovernanceAssessment {
  const text = `${recommendation.title}\n${recommendation.rationale}\n${recommendation.expected_outcome ?? ""}`;
  const categories = new Set<BusinessActionRiskCategory>();

  if (recommendation.risk_level === "high") categories.add("high_business_risk");
  if (recommendation.risk_level === "medium") categories.add("medium_business_risk");
  addCategory(categories, "public_action", PUBLIC_ACTION_RE.test(text));
  addCategory(categories, "spend_sensitive", SPEND_ACTION_RE.test(text));
  addCategory(categories, "external_message", EXTERNAL_MESSAGE_RE.test(text));
  addCategory(categories, "customer_or_vendor_touchpoint", CUSTOMER_VENDOR_RE.test(text));
  addCategory(categories, "commitment_or_destructive_change", COMMITMENT_OR_DESTRUCTIVE_RE.test(text));
  addCategory(categories, "legal_finance_or_compliance", LEGAL_FINANCE_COMPLIANCE_RE.test(text));
  if (categories.size === 0) categories.add("internal_low_risk");

  const riskCategories = Array.from(categories);
  const categoryReasons: Record<Exclude<BusinessActionRiskCategory, "internal_low_risk">, string> = {
    medium_business_risk: "Medium-risk business change needs owner review before execution.",
    high_business_risk: "High-risk business change needs owner review before execution.",
    public_action: "Public-facing work must be approved before anything is published or changed live.",
    spend_sensitive: "Spend, refunds, invoices, quotes, purchases, or budget changes need owner approval.",
    external_message: "External messages, calls, bookings, and outreach need owner approval before sending.",
    customer_or_vendor_touchpoint: "Customer, vendor, partner, or contractor touchpoints need owner approval.",
    commitment_or_destructive_change: "Commitment-making or destructive changes need owner approval and rollback evidence.",
    legal_finance_or_compliance: "Legal, finance, tax, payroll, privacy, or compliance work needs owner approval.",
  };

  const approvalGates = riskCategories
    .filter((category): category is Exclude<BusinessActionRiskCategory, "internal_low_risk"> => category !== "internal_low_risk")
    .map((category) => ({ category, required: true, reason: categoryReasons[category] }));

  const approvalRequired = recommendation.requires_owner_approval || approvalGates.length > 0;
  if (recommendation.requires_owner_approval && !approvalGates.some((gate) => gate.category === "medium_business_risk" || gate.category === "high_business_risk")) {
    approvalGates.push({
      category: recommendation.risk_level === "high" ? "high_business_risk" : "medium_business_risk",
      required: true,
      reason: "Recommendation explicitly requested owner approval.",
    });
  }

  const evidenceRequirements = approvalRequired
    ? [
        "Describe the exact action to execute and the owner-visible business outcome it is meant to improve.",
        "Attach evidence that the action stays inside the approved controlled-autonomy boundary.",
        "Record the owner approval decision before execution begins.",
      ]
    : ["Record private evidence of the internal analysis/result before marking the action complete."];

  if (riskCategories.some((category) => category === "public_action" || category === "external_message" || category === "spend_sensitive" || category === "commitment_or_destructive_change")) {
    evidenceRequirements.push("Capture post-execution proof and rollback/undo status for audit.");
  }

  const escalationRequired = approvalRequired || riskCategories.includes("high_business_risk") || riskCategories.includes("legal_finance_or_compliance");
  const posture = readPolicyPosture(profile.autonomy_policy);

  return {
    posture,
    riskCategories,
    approvalRequired,
    approvalGates,
    evidenceRequirements,
    rollbackRequirement: approvalRequired
      ? "Define a rollback/undo path, owner-visible evidence, and stop condition before execution. If rollback is not possible, keep the action in owner-supervised mode."
      : "Rollback not required for private internal analysis; retain evidence and stop if scope becomes external, public, spend-sensitive, or commitment-making.",
    escalation: {
      required: escalationRequired,
      priority: riskCategories.includes("high_business_risk") || riskCategories.includes("legal_finance_or_compliance") ? "high" : "normal",
      reason: escalationRequired ? approvalGates.map((gate) => gate.reason).join(" ") : null,
    },
  };
}

function buildMeasurementPlan(
  input: RecommendationActionInput,
  governance: BusinessActionGovernanceAssessment,
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
      required: governance.approvalRequired,
      decisionId: null,
      status: governance.approvalRequired ? "awaiting_owner" : "not_required",
    },
    governance,
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

    const governance = assessBusinessActionGovernance(recommendation, profile);
    const status: BusinessActionStatus = governance.approvalRequired ? "awaiting_approval" : "queued";
    const measurementPlan = buildMeasurementPlan(input, governance);

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
        ${governance.approvalRequired},
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

    if (!governance.approvalRequired) return action;

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
          `Risk categories: ${governance.riskCategories.join(", ")}`,
          `Approval gates: ${governance.approvalGates.map((gate) => gate.reason).join(" ")}`,
          `Evidence required: ${governance.evidenceRequirements.join(" ")}`,
          `Rollback requirement: ${governance.rollbackRequirement}`,
          "No public, spend-sensitive, external-message, customer/vendor, or commitment-making work should run until this is approved.",
        ].join("\n\n")},
        ${"Approve only if this action is within the owner's current controlled-autonomy boundary, has enough evidence, and has a rollback/stop path."},
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
        ${governance.escalation.priority},
        ${"pending"},
        ${"business_os_action_approval"},
        ${tx.json(toSqlJson({
          workflow: "business_os_action_loop",
          actionId: action.id,
          recommendationId: recommendation.id,
          approvalRequired: true,
          riskLevel: recommendation.risk_level,
          governance,
        }))},
        ${governance.escalation.reason ?? "Business OS action loop escalated this action because execution is owner-approval-gated."}
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

type BusinessActionTaskRow = {
  id: string;
  hive_id: string;
  assigned_to: string;
  created_by: string;
  status: string;
  title: string;
  brief: string;
};

type BusinessActionScheduleRow = {
  id: string;
  hive_id: string;
  cron_expression: string;
  task_template: Record<string, unknown>;
  enabled: boolean;
  created_by: string;
  origin_type: string;
  origin_key: string | null;
};

type BusinessActionWorkProductRow = {
  id: string;
  task_id: string;
  hive_id: string;
  role_slug: string;
  title: string | null;
  artifact_kind: string | null;
  review_status: string;
};

type BusinessActionConversionResult<T extends Record<string, unknown>> = {
  action: BusinessActionRuntimeRow;
} & T;

function assertActionConvertible(action: BusinessActionRuntimeRow): void {
  if (action.approval_required && action.status !== "approved" && action.status !== "running") {
    throw new Error(`business action ${action.id} requires owner approval before conversion`);
  }
  if (!["queued", "approved", "running"].includes(action.status)) {
    throw new Error(`business action ${action.id} cannot be converted from status ${action.status}`);
  }
}

function businessActionTaskTitle(action: Pick<BusinessActionRuntimeRow, "title">): string {
  return `Business OS action: ${action.title}`;
}

function businessActionTaskBrief(action: BusinessActionRuntimeRow): string {
  return [
    action.brief,
    "",
    `Business OS action ID: ${action.id}`,
    `Expected measurement: ${action.measurement_plan.metricName}`,
    action.measurement_plan.target !== undefined && action.measurement_plan.target !== null ? `Target: ${action.measurement_plan.target}` : null,
    action.approval_required ? `Owner approval decision: ${action.decision_id ?? "missing"}` : "Owner approval: not required",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function withConversion(
  plan: BusinessActionMeasurementPlan,
  conversion: NonNullable<BusinessActionMeasurementPlan["conversions"]>,
): BusinessActionMeasurementPlan {
  return {
    ...plan,
    conversions: {
      ...(plan.conversions ?? {}),
      ...conversion,
    },
  };
}

type ActionSql = Sql | TransactionSql;

async function updateActionConversion(
  tx: ActionSql,
  action: BusinessActionRuntimeRow,
  conversion: NonNullable<BusinessActionMeasurementPlan["conversions"]>,
  status: BusinessActionStatus = action.status,
): Promise<BusinessActionRuntimeRow> {
  const measurementPlan = withConversion(action.measurement_plan, conversion);
  const [updatedAction] = await tx<BusinessActionRuntimeRow[]>`
    UPDATE business_actions
    SET status = ${status},
        measurement_plan = ${tx.json(toSqlJson(measurementPlan))},
        updated_at = now()
    WHERE id = ${action.id}::uuid
    RETURNING id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
              risk_level, decision_id, measurement_plan
  `;
  return updatedAction;
}

export async function convertBusinessActionToAgentTask(
  sql: Sql,
  input: { actionId: string; assignedTo: string; createdBy: string; priority?: number },
): Promise<BusinessActionConversionResult<{ task: BusinessActionTaskRow }>> {
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
    assertActionConvertible(action);

    const [task] = await tx<BusinessActionTaskRow[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief)
      VALUES (
        ${action.hive_id}::uuid,
        ${input.assignedTo},
        ${input.createdBy},
        'pending',
        ${input.priority ?? 5},
        ${businessActionTaskTitle(action)},
        ${businessActionTaskBrief(action)}
      )
      RETURNING id, hive_id, assigned_to, created_by, status, title, brief
    `;

    const updatedAction = await updateActionConversion(tx, action, { agentTaskId: task.id }, "running");
    return { action: updatedAction, task };
  });
}

export async function convertBusinessActionToSchedule(
  sql: Sql,
  input: { actionId: string; assignedTo: string; cronExpression: string; createdBy: string; priority?: number; enabled?: boolean },
): Promise<BusinessActionConversionResult<{ schedule: BusinessActionScheduleRow }>> {
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
    assertActionConvertible(action);

    const taskTemplate = {
      kind: "business_os_action",
      businessActionId: action.id,
      assignedTo: input.assignedTo,
      title: businessActionTaskTitle(action),
      brief: businessActionTaskBrief(action),
      qaRequired: action.approval_required,
      priority: input.priority ?? 5,
    };

    const [schedule] = await tx<BusinessActionScheduleRow[]>`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by, origin_type, origin_key)
      VALUES (
        ${action.hive_id}::uuid,
        ${input.cronExpression},
        ${tx.json(toSqlJson(taskTemplate))},
        ${input.enabled ?? true},
        ${input.createdBy},
        'business_os_action',
        ${action.id}
      )
      RETURNING id, hive_id, cron_expression, task_template, enabled, created_by, origin_type, origin_key
    `;

    const updatedAction = await updateActionConversion(tx, action, { scheduleId: schedule.id });
    return { action: updatedAction, schedule };
  });
}

export async function convertBusinessActionToSopDraft(
  sql: Sql,
  input: { actionId: string; roleSlug: string; createdBy: string; content: string; title?: string },
): Promise<BusinessActionConversionResult<{ task: BusinessActionTaskRow; workProduct: BusinessActionWorkProductRow }>> {
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
    assertActionConvertible(action);

    const [task] = await tx<BusinessActionTaskRow[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, result_summary, completed_at)
      VALUES (
        ${action.hive_id}::uuid,
        ${input.roleSlug},
        ${input.createdBy},
        'completed',
        ${`SOP draft for Business OS action: ${action.title}`},
        ${businessActionTaskBrief(action)},
        ${"SOP draft registered as owner-reviewable Business OS evidence."},
        now()
      )
      RETURNING id, hive_id, assigned_to, created_by, status, title, brief
    `;

    const [workProduct] = await tx<BusinessActionWorkProductRow[]>`
      INSERT INTO work_products (
        task_id, hive_id, role_slug, content, summary, title, artifact_kind, review_status, render_mode, metadata
      )
      VALUES (
        ${task.id}::uuid,
        ${action.hive_id}::uuid,
        ${input.roleSlug},
        ${input.content},
        ${`SOP draft evidence for Business OS action ${action.id}.`},
        ${input.title ?? `SOP draft: ${action.title}`},
        'sop_draft',
        'ready',
        'markdown',
        ${tx.json(toSqlJson({ businessActionId: action.id, measurementMetric: action.measurement_plan.metricName }))}
      )
      RETURNING id, task_id, hive_id, role_slug, title, artifact_kind, review_status
    `;

    const updatedAction = await updateActionConversion(tx, action, { sopTaskId: task.id, sopWorkProductId: workProduct.id });
    return { action: updatedAction, task, workProduct };
  });
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
