import { beforeEach, describe, expect, it } from "vitest";
import { applyOwnerOutcomeReviewAction } from "@/outcomes/review-actions";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let goalId: string;
let outcomeId: string;

beforeEach(async () => {
  await truncateAll(sql);

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('goal-supervisor', 'Goal Supervisor', 'supervisor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [hive] = await sql`
    INSERT INTO hives (slug, name, type, kind)
    VALUES ('outcome-review-hive', 'Outcome Review Hive', 'digital', 'personal_project')
    RETURNING id
  `;
  hiveId = hive.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, budget_cents, spent_cents)
    VALUES (${hiveId}, 'Reviewable handoff', 'achieved', 5000, 0)
    RETURNING id
  `;
  goalId = goal.id;

  const [completion] = await sql`
    INSERT INTO goal_completions (goal_id, summary, evidence, learning_gate, created_by)
    VALUES (${goalId}, 'Handoff complete', ${sql.json({ workProductIds: [] })}, ${sql.json({ category: 'nothing', rationale: 'none' })}, 'goal-supervisor')
    RETURNING id
  `;

  const [outcome] = await sql`
    INSERT INTO owner_outcomes (
      hive_id,
      goal_id,
      goal_completion_id,
      summary,
      why_it_matters,
      recommended_next_action,
      evidence,
      impact_statement
    )
    VALUES (
      ${hiveId},
      ${goalId},
      ${completion.id},
      'Handoff complete',
      'The owner can review the outcome.',
      'Review the result.',
      ${sql.json({ workProductIds: [] })},
      'Project hive impact: owner can inspect the shippable result.'
    )
    RETURNING id
  `;
  outcomeId = outcome.id;
});

describe("owner outcome review actions", () => {
  it("accepts a durable owner outcome without creating follow-up work", async () => {
    await applyOwnerOutcomeReviewAction(sql, {
      outcomeId,
      hiveId,
      action: "accepted",
      actorId: "owner-1",
    });

    const [outcome] = await sql<{ review_state: string }[]>`
      SELECT review_state FROM owner_outcomes WHERE id = ${outcomeId}
    `;
    const [taskCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM tasks WHERE hive_id = ${hiveId}
    `;

    expect(outcome.review_state).toBe("accepted");
    expect(taskCount.count).toBe(0);
  });

  it("marks needs_revision and creates one bounded goal-supervisor follow-up", async () => {
    await applyOwnerOutcomeReviewAction(sql, {
      outcomeId,
      hiveId,
      action: "needs_revision",
      actorId: "owner-1",
      note: "Please tighten the owner summary and fix the launch URL.",
    });
    await applyOwnerOutcomeReviewAction(sql, {
      outcomeId,
      hiveId,
      action: "accepted",
      actorId: "owner-1",
    });
    await applyOwnerOutcomeReviewAction(sql, {
      outcomeId,
      hiveId,
      action: "needs_revision",
      actorId: "owner-1",
      note: "Please tighten the owner summary and fix the launch URL.",
    });

    const [outcome] = await sql<{ review_state: string; route_metadata: { reviewAction?: { revisionTaskId?: string } } }[]>`
      SELECT review_state, route_metadata FROM owner_outcomes WHERE id = ${outcomeId}
    `;
    const tasks = await sql<{ id: string; assigned_to: string; created_by: string; title: string; brief: string; goal_id: string | null }[]>`
      SELECT id, assigned_to, created_by, title, brief, goal_id
      FROM tasks
      WHERE hive_id = ${hiveId}
    `;

    expect(outcome.review_state).toBe("needs_revision");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_to).toBe("goal-supervisor");
    expect(tasks[0].created_by).toBe("owner");
    expect(tasks[0].goal_id).toBe(goalId);
    expect(tasks[0].title).toContain("[Outcome revision]");
    expect(tasks[0].brief).toContain("Please tighten the owner summary");
    expect(tasks[0].brief.length).toBeLessThanOrEqual(1800);
    expect(outcome.route_metadata.reviewAction?.revisionTaskId).toBe(tasks[0].id);
  });

  it("rejects needs_revision when no revision note is provided", async () => {
    await expect(applyOwnerOutcomeReviewAction(sql, {
      outcomeId,
      hiveId,
      action: "needs_revision",
      actorId: "owner-1",
    })).rejects.toThrow(/revision note/i);
  });

  it("marks process candidates without activating policies or pipelines", async () => {
    await applyOwnerOutcomeReviewAction(sql, {
      outcomeId,
      hiveId,
      action: "converted_to_process_candidate",
      actorId: "owner-1",
      note: "This looks repeatable for future launch pages.",
    });

    const [outcome] = await sql<{ review_state: string; route_metadata: { processCandidate?: { status?: string; note?: string } } }[]>`
      SELECT review_state, route_metadata FROM owner_outcomes WHERE id = ${outcomeId}
    `;
    const [standingInstructionCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM standing_instructions WHERE hive_id = ${hiveId}
    `;
    const [pipelineTemplateCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pipeline_templates WHERE hive_id = ${hiveId}
    `;
    const [pipelineRunCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pipeline_runs WHERE hive_id = ${hiveId}
    `;

    expect(outcome.review_state).toBe("converted_to_process_candidate");
    expect(outcome.route_metadata.processCandidate).toMatchObject({
      status: "candidate_only",
      note: "This looks repeatable for future launch pages.",
    });
    expect(standingInstructionCount.count).toBe(0);
    expect(pipelineTemplateCount.count).toBe(0);
    expect(pipelineRunCount.count).toBe(0);
  });
});
