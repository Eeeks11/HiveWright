import { beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { runStrategicInitiativeEvaluation } from "@/initiative-engine";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let otherHiveId: string;
let goalId: string;
let scheduleId: string;

async function seedRole(sql: Sql) {
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('strategy-agent', 'Strategy Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
}

async function submitWorkDirect(input: {
  hiveId: string;
  input: string;
  goalId?: string | null;
  priority: number;
  acceptanceCriteria: string;
}) {
  if (input.goalId) {
    const [task] = await sql<Array<{ id: string; title: string }>>`
      INSERT INTO tasks (
        hive_id, goal_id, title, brief, status, assigned_to,
        created_by, acceptance_criteria, priority, qa_required
      )
      VALUES (
        ${input.hiveId}, ${input.goalId}, 'Strategic next action', ${input.input},
        'pending', 'strategy-agent', 'initiative-engine', ${input.acceptanceCriteria},
        ${input.priority}, false
      )
      RETURNING id, title
    `;
    return {
      id: task.id,
      type: "task" as const,
      title: task.title,
      classification: { provider: "test", model: "test", confidence: 0.93, reasoning: "task", usedFallback: false },
    };
  }

  const [goal] = await sql<Array<{ id: string; title: string }>>`
    INSERT INTO goals (hive_id, title, description, status)
    VALUES (${input.hiveId}, 'Strategic initiative goal', ${input.input}, 'active')
    RETURNING id, title
  `;
  return {
    id: goal.id,
    type: "goal" as const,
    title: goal.title,
    classification: { provider: "test", model: "test", confidence: 0.88, reasoning: "goal", usedFallback: false },
  };
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedRole(sql);
  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type, kind, description, mission)
    VALUES (
      'strategic-biz',
      'Strategic Bakery',
      'digital',
      'business',
      'A local bakery growth hive',
      'Grow profitable wholesale bakery relationships without adding chaotic admin work.'
    )
    RETURNING id
  `;
  hiveId = hive.id;

  const [otherHive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type, kind, description, mission)
    VALUES (
      'other-hive',
      'Other Hive',
      'digital',
      'creative',
      'A separate creative hive',
      'Ship artwork commissions.'
    )
    RETURNING id
  `;
  otherHiveId = otherHive.id;

  await sql`
    INSERT INTO hive_targets (hive_id, title, target_value, sort_order)
    VALUES (${hiveId}, 'Add three wholesale customers', '3 signed cafes this quarter', 0)
  `;

  const [goal] = await sql<Array<{ id: string }>>`
    INSERT INTO goals (hive_id, title, description, status, created_at, updated_at)
    VALUES (
      ${hiveId},
      'Build wholesale outreach list',
      'Find and qualify cafes that match the bakery margin target.',
      'active',
      NOW() - interval '2 days',
      NOW() - interval '2 days'
    )
    RETURNING id
  `;
  goalId = goal.id;

  await sql`
    INSERT INTO goals (hive_id, title, description, status)
    VALUES (${otherHiveId}, 'Improve HiveWright product roadmap', 'This must never leak into the bakery hive.', 'active')
  `;

  await sql`
    INSERT INTO goal_completions (goal_id, summary, evidence, learning_gate, created_by)
    VALUES (${goalId}, 'Validated the first cafe segment and found owner contact gaps.', ${sql.json({})}, ${sql.json({})}, 'goal-supervisor')
  `;

  await sql`
    INSERT INTO business_records (
      hive_id, source_connector, external_id, record_family, record_type,
      title, summary, metadata, normalized, raw_redacted
    )
    VALUES (
      ${hiveId}, 'world-scan', 'bakery-signal-1', 'signal', 'local_market_signal',
      'Two nearby cafes changed ownership', 'Potential wholesale outreach window.',
      ${sql.json({})}, ${sql.json({})}, ${sql.json({})}
    )
  `;

  await sql`
    INSERT INTO hive_memory (hive_id, category, content, confidence, sensitivity)
    VALUES (${hiveId}, 'strategy', 'Owner prefers outreach that protects bakery production capacity.', 0.95, 'internal')
  `;

  const [schedule] = await sql<Array<{ id: string }>>`
    INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
    VALUES (
      ${hiveId},
      '0 */6 * * *',
      ${sql.json({ kind: 'strategic-initiative-evaluation', assignedTo: 'initiative-engine' })},
      true,
      NOW() - interval '1 minute',
      'test'
    )
    RETURNING id
  `;
  scheduleId = schedule.id;
});

describe.sequential("runStrategicInitiativeEvaluation", () => {
  it("injects mission, targets, completed work, records, memory, and hive-only context into the proposed next action", async () => {
    const result = await runStrategicInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, { submitWork: submitWorkDirect });

    expect(result.tasksCreated).toBe(1);
    expect(result.candidatesEvaluated).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      actionTaken: "create_task",
      goalId,
      evidence: {
        mode: "strategic_initiative",
        context: {
          hive: { id: hiveId, name: "Strategic Bakery", hasMission: true },
          targets: [{ title: "Add three wholesale customers", targetValue: "3 signed cafes this quarter" }],
          recentCompletedWorkCount: 1,
          recentRecords: [{ sourceConnector: "world-scan", recordType: "local_market_signal" }],
          memoryCount: 1,
        },
        candidate: {
          kind: "strategic-goal-advance",
          goalId,
        },
      },
    });

    const [task] = await sql<Array<{ hive_id: string; goal_id: string; brief: string }>>`
      SELECT hive_id, goal_id, brief
      FROM tasks
      WHERE id = ${result.outcomes[0].createdTaskId!}
    `;
    expect(task.hive_id).toBe(hiveId);
    expect(task.goal_id).toBe(goalId);
    expect(task.brief).toContain("Grow profitable wholesale bakery relationships");
    expect(task.brief).toContain("Add three wholesale customers");
    expect(task.brief).toContain("Validated the first cafe segment");
    expect(task.brief).toContain("Two nearby cafes changed ownership");
    expect(task.brief).toContain("protects bakery production capacity");
    expect(task.brief).not.toContain("Improve HiveWright product roadmap");
  });

  it("no-ops when the hive has no mission, targets, or clear strategic signal", async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type, kind, description)
      VALUES (${hiveId}, 'quiet-hive', 'Quiet Hive', 'digital', 'personal_project', 'No strategy yet')
    `;

    const result = await runStrategicInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId: null },
    }, { submitWork: submitWorkDirect });

    expect(result.tasksCreated).toBe(0);
    expect(result.noop).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      actionTaken: "noop",
      suppressionReason: null,
      evidence: {
        noOp: { reason: "insufficient_mission_target_signal" },
      },
    });
  });

  it("creates a new strategic goal when there is a mission/target but no active goal to advance", async () => {
    await sql`UPDATE goals SET status = 'achieved' WHERE hive_id = ${hiveId}`;

    const result = await runStrategicInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, { submitWork: submitWorkDirect });

    expect(result.tasksCreated).toBe(0);
    expect(result.outcomes[0].actionTaken).toBe("create_goal");
    expect(result.outcomes[0].createdGoalId).toBeTruthy();
    expect(result.outcomes[0].evidence).toMatchObject({
      candidate: {
        kind: "strategic-new-initiative",
        targetTitle: "Add three wholesale customers",
      },
    });
  });

  it("uses distinct strategic trigger/dedupe keys rather than dormant-goal recovery semantics", async () => {
    const result = await runStrategicInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    }, { submitWork: submitWorkDirect });

    const [run] = await sql<Array<{ trigger_type: string; guardrail_config: { mode?: string } }>>`
      SELECT trigger_type, guardrail_config
      FROM initiative_runs
      WHERE id = ${result.runId}
    `;
    expect(run).toMatchObject({
      trigger_type: "strategic_schedule",
      guardrail_config: { mode: "strategic_initiative" },
    });

    const [decision] = await sql<Array<{ candidate_key: string; dedupe_key: string }>>`
      SELECT candidate_key, dedupe_key
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
      LIMIT 1
    `;
    expect(decision.candidate_key).toMatch(/^strategic-initiative:/);
    expect(decision.dedupe_key).toMatch(/^strategic-initiative:/);
    expect(decision.candidate_key).not.toContain("dormant-goal-next-task");
  });
});
