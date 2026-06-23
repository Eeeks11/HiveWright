import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../../tests/_lib/test-db";

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: vi.fn().mockResolvedValue({
    user: { id: "owner:test", email: "owner@example.com", isSystemOwner: true },
  }),
}));

import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import {
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

    const [decision] = await sql<{ kind: string; status: string; context: string }[]>`
      SELECT kind, status, context
      FROM decisions
      WHERE id = ${action.decision_id}::uuid
    `;
    expect(decision.kind).toBe("business_os_action_approval");
    expect(decision.status).toBe("pending");
    expect(decision.context).toContain("No public, spend-sensitive, external, customer/vendor");

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
  });
});
