import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../../tests/_lib/test-db";

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: vi.fn().mockResolvedValue({
    user: { id: "owner:test", email: "owner@example.com", isSystemOwner: true },
  }),
}));

import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import {
  convertBusinessActionToAgentTask,
  convertBusinessActionToSchedule,
  convertBusinessActionToSopDraft,
  convertRecommendationToBusinessAction,
  recordBusinessActionMeasurement,
  startApprovedBusinessAction,
  type BusinessActionMeasurement,
} from "./business-action-runtime";

async function insertBusinessHive(): Promise<{ hiveId: string; profileId: string }> {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, kind, description, mission)
    VALUES ('Business OS Runtime Fixture', ${`business-os-runtime-${Math.random().toString(36).slice(2, 8)}`}, 'digital', 'business', 'Runtime fixture', 'Improve business operations safely')
    RETURNING id
  `;

  const [profile] = await sql<{ id: string }[]>`
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
    )
    VALUES (
      ${hive.id}::uuid,
      'existing_business',
      'Runtime Test Co',
      'services',
      'operating',
      'Existing business used for action-loop runtime tests.',
      ${sql.json(['Improve marketing follow-up'])},
      ${sql.json(['No customer-facing changes without owner approval'])},
      ${sql.json({ externalActions: 'owner_approval_required' })},
      ${sql.json({ monthlyCents: 0 })},
      ${sql.json({ default: 'shadow_mode' })},
      ${sql.json({ fixture: true })}
    )
    RETURNING id
  `;

  return { hiveId: hive.id, profileId: profile.id };
}

async function insertRecommendation(input: {
  hiveId: string;
  title?: string;
  rationale?: string;
  expectedOutcome?: string;
  requiresOwnerApproval?: boolean;
  riskLevel?: 'low' | 'medium' | 'high' | null;
}): Promise<string> {
  const [recommendation] = await sql<{ id: string }[]>`
    INSERT INTO business_recommendations (
      hive_id,
      title,
      rationale,
      expected_outcome,
      estimated_effort,
      risk_level,
      requires_owner_approval,
      status
    )
    VALUES (
      ${input.hiveId}::uuid,
      ${input.title ?? 'Draft a customer follow-up offer'},
      ${input.rationale ?? 'Create a small follow-up action that could contact customers.'},
      ${input.expectedOutcome ?? 'More repeat bookings from existing customers'},
      'small',
      ${input.riskLevel ?? 'medium'},
      ${input.requiresOwnerApproval ?? true},
      'proposed'
    )
    RETURNING id
  `;

  return recommendation.id;
}

function ownerDecisionRequest(hiveId: string, body: Record<string, unknown>) {
  return new Request("http://localhost/api/decisions/decision/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hiveId, ...body }),
  });
}

async function insertRole(slug: string): Promise<void> {
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES (${slug}, ${slug.replace(/-/g, " ")}, 'executor', 'auto')
    ON CONFLICT (slug) DO NOTHING
  `;
}

describe("Business OS action-loop runtime", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("converts sensitive recommendations into approval-gated actions with measurement state", async () => {
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({ hiveId });

    const action = await convertRecommendationToBusinessAction(sql, {
      recommendationId,
      businessOsProfileId: profileId,
      systemKey: "marketing",
      actionType: "follow_up_offer",
      measurement: {
        metricName: "repeat booking enquiries",
        baseline: 0,
        target: 3,
        cadence: "weekly",
      },
    });

    expect(action.status).toBe("awaiting_approval");
    expect(action.approval_required).toBe(true);
    expect(action.decision_id).toEqual(expect.any(String));
    expect(action.measurement_plan).toMatchObject({
      metricName: "repeat booking enquiries",
      baseline: 0,
      target: 3,
      cadence: "weekly",
      status: "planned",
      loopStage: "plan",
      approval: {
        required: true,
        decisionId: action.decision_id,
        status: "awaiting_owner",
      },
    });

    expect(action.measurement_plan.governance).toMatchObject({
      approvalRequired: true,
      riskCategories: expect.arrayContaining(["medium_business_risk", "external_message", "customer_or_vendor_touchpoint"]),
      escalation: { required: true, priority: "normal" },
    });
    expect(action.measurement_plan.governance.evidenceRequirements.join(" ")).toContain("Record the owner approval decision");
    expect(action.measurement_plan.governance.rollbackRequirement).toContain("rollback/undo path");

    const [decision] = await sql<{ kind: string; status: string; context: string; route_metadata: { governance?: { riskCategories?: string[] } } }[]>`
      SELECT kind, status, context, route_metadata
      FROM decisions
      WHERE id = ${action.decision_id}::uuid
    `;
    expect(decision.kind).toBe("business_os_action_approval");
    expect(decision.status).toBe("pending");
    expect(decision.context).toContain("No public, spend-sensitive, external-message");
    expect(decision.context).toContain("Rollback requirement:");
    expect(decision.route_metadata.governance?.riskCategories).toEqual(expect.arrayContaining(["external_message"]));

    const [recommendation] = await sql<{ status: string }[]>`
      SELECT status FROM business_recommendations WHERE id = ${recommendationId}::uuid
    `;
    expect(recommendation.status).toBe("converted_to_action");
  });

  it("runs approved low-autonomy actions through execute and measure states", async () => {
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({ hiveId, riskLevel: "high" });

    const action = await convertRecommendationToBusinessAction(sql, {
      recommendationId,
      businessOsProfileId: profileId,
      systemKey: "sales-conversion",
      measurement: { metricName: "qualified follow-up replies", baseline: 1, target: 4 },
    });

    const approvalResponse = await respondToDecision(ownerDecisionRequest(hiveId, {
      response: "approved",
      selectedOptionKey: "approve",
      comment: "Approved for shadow-mode execution only.",
    }), { params: Promise.resolve({ id: action.decision_id! }) });
    const approvalBody = await approvalResponse.json();
    expect(approvalResponse.status).toBe(200);
    expect(approvalBody.data.businessActionResult).toMatchObject({
      actionId: action.id,
      status: "approved",
      approvalStatus: "approved",
    });

    const [approved] = await sql<typeof action[]>`
      SELECT id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
             risk_level, decision_id, measurement_plan
      FROM business_actions
      WHERE id = ${action.id}::uuid
    `;
    expect(approved.status).toBe("approved");
    expect(approved.measurement_plan.approval?.status).toBe("approved");
    expect(approved.measurement_plan.loopStage).toBe("execute");

    const running = await startApprovedBusinessAction(sql, action.id);
    expect(running.status).toBe("running");

    const measurement: BusinessActionMeasurement = {
      measuredAt: "2026-06-23T05:00:00.000Z",
      summary: "Shadow execution produced two qualified replies without external send automation.",
      metricName: "qualified follow-up replies",
      baseline: 1,
      current: 2,
      target: 4,
      confidence: "medium",
      evidenceRefs: [{ kind: "business_record", id: "fixture-result" }],
      readinessScore: 58,
      nextRecommendation: "Keep the manual follow-up script but improve segmentation before any autonomous send.",
    };

    const measured = await recordBusinessActionMeasurement(sql, { actionId: action.id, measurement });
    expect(measured.status).toBe("completed");
    expect(measured.measurement_plan.status).toBe("measured");
    expect(measured.measurement_plan.loopStage).toBe("optimise");
    expect(measured.measurement_plan.measurements).toHaveLength(1);
    expect(measured.measurement_plan.measurements[0]).toMatchObject({ current: 2, readinessScore: 58 });

    const [readiness] = await sql<{ source_kind: string; source_id: string; system_key: string; readiness_score: number; summary: string }[]>`
      SELECT source_kind, source_id, system_key, readiness_score, summary
      FROM business_system_readiness
      WHERE source_id = ${action.id}::uuid
    `;
    expect(readiness).toMatchObject({
      source_kind: "loop_measurement",
      source_id: action.id,
      system_key: "sales-conversion",
      readiness_score: 58,
      summary: measurement.summary,
    });
  });

  it("rejects approval-gated Business OS actions through the owner decision route without execution", async () => {
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({ hiveId, riskLevel: "high" });

    const action = await convertRecommendationToBusinessAction(sql, {
      recommendationId,
      businessOsProfileId: profileId,
      systemKey: "sales-conversion",
    });

    const rejectionResponse = await respondToDecision(ownerDecisionRequest(hiveId, {
      response: "rejected",
      selectedOptionKey: "reject",
      comment: "Revise before any execution.",
    }), { params: Promise.resolve({ id: action.decision_id! }) });
    const rejectionBody = await rejectionResponse.json();
    expect(rejectionResponse.status).toBe(200);
    expect(rejectionBody.data.businessActionResult).toMatchObject({
      actionId: action.id,
      status: "cancelled",
      approvalStatus: "rejected",
    });

    const [cancelled] = await sql<typeof action[]>`
      SELECT id, hive_id, business_os_profile_id, recommendation_id, title, brief, status, approval_required,
             risk_level, decision_id, measurement_plan
      FROM business_actions
      WHERE id = ${action.id}::uuid
    `;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.measurement_plan.approval?.status).toBe("rejected");
    expect(cancelled.measurement_plan.loopStage).toBe("plan");

    const [decision] = await sql<{ owner_response: string; selected_option_key: string }[]>`
      SELECT owner_response, selected_option_key
      FROM decisions
      WHERE id = ${action.decision_id}::uuid
    `;
    expect(decision.selected_option_key).toBe("reject");
    expect(decision.owner_response).toContain("rejected");
  });

  it("gates public, spend-sensitive, and external-message recommendations before execution", async () => {
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({
      hiveId,
      title: "Publish a discount offer and email customers",
      rationale: "Spend $250 on ads, post the offer publicly, and send customer outreach messages.",
      expectedOutcome: "More customer bookings from the public offer",
      riskLevel: "low",
      requiresOwnerApproval: false,
    });

    const action = await convertRecommendationToBusinessAction(sql, {
      recommendationId,
      businessOsProfileId: profileId,
      systemKey: "marketing",
      actionType: "campaign_launch",
    });

    expect(action.status).toBe("awaiting_approval");
    expect(action.approval_required).toBe(true);
    expect(action.measurement_plan.governance.riskCategories).toEqual(expect.arrayContaining([
      "public_action",
      "spend_sensitive",
      "external_message",
      "customer_or_vendor_touchpoint",
    ]));
    expect(action.measurement_plan.governance.approvalGates.map((gate) => gate.category)).toEqual(expect.arrayContaining([
      "public_action",
      "spend_sensitive",
      "external_message",
    ]));
    expect(action.measurement_plan.governance.evidenceRequirements.join(" ")).toContain("rollback/undo status");

    const [decision] = await sql<{ priority: string; context: string }[]>`
      SELECT priority, context
      FROM decisions
      WHERE id = ${action.decision_id}::uuid
    `;
    expect(decision.priority).toBe("normal");
    expect(decision.context).toContain("Approval gates:");
    expect(decision.context).toContain("Spend, refunds, invoices");
  });

  it("gates low-risk finance and compliance recommendations before execution", async () => {
    const { hiveId, profileId } = await insertBusinessHive();

    const cases = [
      {
        title: "Prepare GST BAS lodgement in Xero for March quarter",
        rationale: "Prepare the BAS pack, GST figures, and ATO lodgement checklist from Xero records.",
        expectedOutcome: "Ready-to-review March quarter compliance pack",
      },
      {
        title: "Reconcile bank transactions in Xero and lodge BAS",
        rationale: "Reconcile banking transactions, check wages and superannuation entries, then prepare lodgement notes.",
        expectedOutcome: "Bank reconciliation and BAS draft ready for owner sign-off",
      },
    ];

    for (const recommendationInput of cases) {
      const recommendationId = await insertRecommendation({
        hiveId,
        ...recommendationInput,
        riskLevel: "low",
        requiresOwnerApproval: false,
      });

      const action = await convertRecommendationToBusinessAction(sql, {
        recommendationId,
        businessOsProfileId: profileId,
        systemKey: "finance",
        actionType: "compliance_preparation",
      });

      expect(action.status).toBe("awaiting_approval");
      expect(action.approval_required).toBe(true);
      expect(action.measurement_plan.governance.riskCategories).toEqual(expect.arrayContaining(["legal_finance_or_compliance"]));
      expect(action.measurement_plan.governance.approvalGates.map((gate) => gate.category)).toEqual(expect.arrayContaining(["legal_finance_or_compliance"]));
      expect(action.measurement_plan.governance.escalation).toMatchObject({ required: true, priority: "high" });

      const [decision] = await sql<{ priority: string; route_metadata: { governance?: { riskCategories?: string[] } } }[]>`
        SELECT priority, route_metadata
        FROM decisions
        WHERE id = ${action.decision_id}::uuid
      `;
      expect(decision.priority).toBe("high");
      expect(decision.route_metadata.governance?.riskCategories).toEqual(expect.arrayContaining(["legal_finance_or_compliance"]));
    }
  });

  it("gates low-risk commitment and destructive recommendations before execution", async () => {
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({
      hiveId,
      title: "Remove the old booking form and commit to the new pricing page",
      rationale: "Delete the legacy form, terminate the old workflow, and sign off on the new live pricing change.",
      expectedOutcome: "Only the new pricing flow remains active",
      riskLevel: "low",
      requiresOwnerApproval: false,
    });

    const action = await convertRecommendationToBusinessAction(sql, {
      recommendationId,
      businessOsProfileId: profileId,
      systemKey: "operations",
      actionType: "destructive_change",
    });

    expect(action.status).toBe("awaiting_approval");
    expect(action.approval_required).toBe(true);
    expect(action.measurement_plan.governance.riskCategories).toEqual(expect.arrayContaining(["commitment_or_destructive_change"]));
    expect(action.measurement_plan.governance.approvalGates.map((gate) => gate.category)).toEqual(expect.arrayContaining(["commitment_or_destructive_change"]));
    expect(action.measurement_plan.governance.evidenceRequirements.join(" ")).toContain("rollback/undo status");

    const [decision] = await sql<{ priority: string; context: string; route_metadata: { governance?: { riskCategories?: string[] } } }[]>`
      SELECT priority, context, route_metadata
      FROM decisions
      WHERE id = ${action.decision_id}::uuid
    `;
    expect(decision.priority).toBe("normal");
    expect(decision.context).toContain("Commitment-making or destructive changes");
    expect(decision.route_metadata.governance?.riskCategories).toEqual(expect.arrayContaining(["commitment_or_destructive_change"]));
  });

  it("converts approved Business OS actions into real agent task, schedule, and SOP evidence", async () => {
    await insertRole("operations-agent");
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({ hiveId, riskLevel: "high" });

    const action = await convertRecommendationToBusinessAction(sql, {
      recommendationId,
      businessOsProfileId: profileId,
      systemKey: "operations",
      measurement: { metricName: "sop evidence reviewed", baseline: 0, target: 1 },
    });

    await respondToDecision(ownerDecisionRequest(hiveId, {
      response: "approved",
      selectedOptionKey: "approve",
      comment: "Approved for governed internal execution.",
    }), { params: Promise.resolve({ id: action.decision_id! }) });

    const taskConversion = await convertBusinessActionToAgentTask(sql, {
      actionId: action.id,
      assignedTo: "operations-agent",
      createdBy: "business-os:test",
    });
    expect(taskConversion.task).toMatchObject({
      hive_id: hiveId,
      assigned_to: "operations-agent",
      created_by: "business-os:test",
      status: "pending",
      title: "Business OS action: Draft a customer follow-up offer",
    });
    expect(taskConversion.action.status).toBe("running");
    expect(taskConversion.action.measurement_plan.conversions?.agentTaskId).toBe(taskConversion.task.id);

    const scheduleConversion = await convertBusinessActionToSchedule(sql, {
      actionId: action.id,
      assignedTo: "operations-agent",
      cronExpression: "0 9 * * 1",
      createdBy: "business-os:test",
    });
    expect(scheduleConversion.schedule).toMatchObject({
      hive_id: hiveId,
      cron_expression: "0 9 * * 1",
      enabled: true,
      created_by: "business-os:test",
      origin_type: "business_os_action",
      origin_key: action.id,
    });
    expect(scheduleConversion.schedule.task_template).toMatchObject({
      assignedTo: "operations-agent",
      title: "Business OS action: Draft a customer follow-up offer",
      businessActionId: action.id,
    });
    expect(scheduleConversion.action.measurement_plan.conversions?.scheduleId).toBe(scheduleConversion.schedule.id);

    const sopConversion = await convertBusinessActionToSopDraft(sql, {
      actionId: action.id,
      roleSlug: "operations-agent",
      createdBy: "business-os:test",
      content: "# Follow-up SOP\n\n1. Review evidence.\n2. Prepare owner-safe draft.",
    });
    expect(sopConversion.task.status).toBe("completed");
    expect(sopConversion.workProduct).toMatchObject({
      hive_id: hiveId,
      role_slug: "operations-agent",
      artifact_kind: "sop_draft",
      review_status: "ready",
    });
    expect(sopConversion.action.measurement_plan.conversions?.sopWorkProductId).toBe(sopConversion.workProduct.id);
  });

  it("keeps sensitive Business OS actions approval-gated before creating real work", async () => {
    await insertRole("operations-agent");
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({ hiveId, riskLevel: "high" });
    const action = await convertRecommendationToBusinessAction(sql, { recommendationId, businessOsProfileId: profileId });

    await expect(convertBusinessActionToAgentTask(sql, {
      actionId: action.id,
      assignedTo: "operations-agent",
      createdBy: "business-os:test",
    })).rejects.toThrow("requires owner approval before conversion");

    const taskRows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM tasks WHERE hive_id = ${hiveId}::uuid`;
    expect(taskRows[0].count).toBe("0");
  });

  it("queues safe internal recommendations without creating owner approval decisions", async () => {
    const { hiveId, profileId } = await insertBusinessHive();
    const recommendationId = await insertRecommendation({
      hiveId,
      title: "Summarise internal fulfilment SOP gaps",
      rationale: "Review internal notes and produce a private gap list only.",
      expectedOutcome: "Clearer internal operations backlog",
      riskLevel: "low",
      requiresOwnerApproval: false,
    });

    const action = await convertRecommendationToBusinessAction(sql, {
      recommendationId,
      businessOsProfileId: profileId,
      systemKey: "operations",
      actionType: "internal_analysis",
    });

    expect(action.status).toBe("queued");
    expect(action.approval_required).toBe(false);
    expect(action.decision_id).toBeNull();
    expect(action.measurement_plan.approval).toMatchObject({
      required: false,
      decisionId: null,
      status: "not_required",
    });
    expect(action.measurement_plan.governance).toMatchObject({
      approvalRequired: false,
      riskCategories: ["internal_low_risk"],
      escalation: { required: false, priority: "normal", reason: null },
    });
  });
});
