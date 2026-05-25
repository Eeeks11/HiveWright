import { beforeEach, describe, expect, it } from "vitest";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";
import { getHiveScoreboard } from "@/hives/scoreboard";

async function insertHive(kind: string, label: string, mode = "active"): Promise<string> {
  const ns = createFixtureNamespace(`scoreboard-${label}`);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type, kind, operating_mode, description, mission)
    VALUES (
      ${ns.slug(label)},
      ${`${label} Hive`},
      'digital',
      ${kind},
      ${mode},
      ${`${label} description`},
      ${`${label} mission`}
    )
    RETURNING id
  `;
  return row.id;
}

beforeEach(async () => {
  await truncateAll(sql);
});

describe("getHiveScoreboard", () => {
  it("summarizes business outcome movement without leaking other hives or internal decisions", async () => {
    const hiveId = await insertHive("business", "revenue");
    const otherHiveId = await insertHive("business", "other");

    await sql`
      INSERT INTO hive_operating_profiles (
        hive_id,
        kind,
        purpose,
        desired_outcome,
        current_30_day_outcome,
        constraints,
        approval_rules,
        forbidden_actions,
        important_context,
        success_criteria,
        stop_or_pause_criteria,
        kind_profile
      )
      VALUES (
        ${hiveId},
        'business',
        'Grow the service offer',
        'Reach a repeatable sales loop',
        'Book 3 qualified calls',
        '[]'::jsonb,
        '[]'::jsonb,
        '[]'::jsonb,
        '[]'::jsonb,
        '[]'::jsonb,
        '[]'::jsonb,
        '{}'::jsonb
      )
    `;

    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${hiveId}, 'Launch outreach campaign', 'Find first customers', 'active')
      RETURNING id
    `;
    await sql`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES
        (${hiveId}, 'Close first deal', 'Move a lead to paid', 'active'),
        (${otherHiveId}, 'Other hive goal', 'Should not appear', 'active')
    `;
    await sql`
      INSERT INTO goal_completions (goal_id, summary, evidence, created_by)
      VALUES (${goal.id}, 'Landing page shipped.', '{}'::jsonb, 'owner')
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id)
      VALUES
        (${hiveId}, 'dev-agent', 'owner', 'blocked', 'Fix checkout copy', 'Blocked on owner input', ${goal.id}),
        (${otherHiveId}, 'dev-agent', 'owner', 'blocked', 'Other blocked task', 'Should not appear', NULL)
    `;

    await sql`
      INSERT INTO decisions (hive_id, goal_id, title, context, options, priority, status, kind, is_qa_fixture)
      VALUES
        (${hiveId}, ${goal.id}, 'Approve first offer', 'Owner needs to choose pricing.', '{}'::jsonb, 'high', 'pending', 'decision', false),
        (${hiveId}, ${goal.id}, 'Hive supervisor heartbeat', 'Internal heartbeat', '{"internal": true}'::jsonb, 'normal', 'pending', 'decision', false),
        (${otherHiveId}, NULL, 'Other hive approval', 'Should not appear', '{}'::jsonb, 'high', 'pending', 'decision', false)
    `;

    await sql`
      INSERT INTO business_records (
        hive_id,
        source_connector,
        external_id,
        record_family,
        record_type,
        status,
        title,
        amount_cents,
        currency,
        occurred_at,
        normalized,
        raw_redacted,
        metadata
      )
      VALUES
        (${hiveId}, 'manual', 'sale-1', 'finance', 'sale', 'paid', 'First sale', 50000, 'USD', '2026-05-19', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
        (${hiveId}, 'manual', 'expense-1', 'finance', 'expense', 'paid', 'Ad spend', 12000, 'USD', '2026-05-19', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
        (${hiveId}, 'manual', 'lead-1', 'relationship', 'lead', 'open', 'Qualified lead', NULL, NULL, '2026-05-20', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
        (${hiveId}, 'manual', 'campaign-1', 'operations', 'campaign', 'active', 'Cold email test', NULL, NULL, '2026-05-20', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
        (${otherHiveId}, 'manual', 'sale-other', 'finance', 'sale', 'paid', 'Other sale', 999999, 'USD', '2026-05-20', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `;

    const scoreboard = await getHiveScoreboard(sql, hiveId, {
      now: new Date("2026-05-21T00:00:00.000Z"),
    });
    expect(scoreboard).not.toBeNull();
    const board = scoreboard!;

    expect(board).toMatchObject({
      hive: {
        id: hiveId,
        kind: "business",
        name: "revenue Hive",
        currentOutcome: "Book 3 qualified calls",
        status: "active",
      },
      activeGoals: {
        count: 2,
        items: [
          expect.objectContaining({ title: "Close first deal" }),
          expect.objectContaining({ title: "Launch outreach campaign" }),
        ],
      },
      blockedItems: {
        count: 1,
        items: [expect.objectContaining({ title: "Fix checkout copy" })],
      },
      ownerActionsNeeded: {
        count: 1,
        items: [expect.objectContaining({ title: "Approve first offer" })],
      },
      recentCompletions: {
        count: 1,
        items: [expect.objectContaining({ summary: "Landing page shipped." })],
      },
      kindMetrics: {
        kind: "business",
        revenueCents: 50000,
        expensesCents: 12000,
        profitLossEstimateCents: 38000,
        leads: 1,
        activeCampaigns: 1,
        salesPipeline: 1,
      },
    });
    expect(board.nextRecommendedAction).toMatch(/Approve first offer/i);
  });

  it("uses non-business empty-state guidance and research metrics for research hives", async () => {
    const hiveId = await insertHive("research", "vendor-research", "exploring");

    const scoreboard = await getHiveScoreboard(sql, hiveId, {
      now: new Date("2026-05-21T00:00:00.000Z"),
    });
    expect(scoreboard).not.toBeNull();
    const board = scoreboard!;

    expect(board.hive).toMatchObject({
      id: hiveId,
      kind: "research",
      status: "exploring",
    });
    expect(board.kindMetrics).toMatchObject({
      kind: "research",
      questionsAnswered: 0,
      sourcesReviewed: 0,
      confidence: "unknown",
      unresolvedUnknowns: 0,
    });
    expect(board.emptyStateGuidance).toMatch(/research records or goals/i);
    expect(board.emptyStateGuidance).not.toMatch(/revenue|customer|sales/i);
    expect(board.nextRecommendedAction).toMatch(/add research records or goals/i);
  });

  it("reports project deadline risk from open targets and produced deliverables", async () => {
    const hiveId = await insertHive("personal_project", "project-risk", "active");
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${hiveId}, 'Ship prototype', 'Finish the first usable artifact', 'active')
      RETURNING id
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'completed', 'Build prototype', 'Create artifact', ${goal.id})
      RETURNING id
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content, summary, title)
      VALUES (${task.id}, ${hiveId}, 'dev-agent', 'Prototype content', 'Prototype summary', 'Prototype artifact')
    `;
    await sql`
      INSERT INTO hive_targets (hive_id, title, deadline, status, sort_order)
      VALUES (${hiveId}, 'Prototype due', '2026-05-20', 'open', 1)
    `;
    await sql`
      INSERT INTO business_records (
        hive_id,
        source_connector,
        external_id,
        record_family,
        record_type,
        status,
        title,
        occurred_at,
        normalized,
        raw_redacted,
        metadata
      )
      VALUES
        (${hiveId}, 'manual', 'milestone-1', 'progress', 'milestone', 'done', 'Wireframe approved', '2026-05-20', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
        (${hiveId}, 'manual', 'blocker-1', 'planning', 'blocker', 'open', 'Waiting on supplier quote', '2026-05-20', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `;

    const scoreboard = await getHiveScoreboard(sql, hiveId, {
      now: new Date("2026-05-21T00:00:00.000Z"),
    });
    expect(scoreboard).not.toBeNull();
    const board = scoreboard!;

    expect(board.kindMetrics).toMatchObject({
      kind: "personal_project",
      milestoneProgress: { completed: 1, total: 1 },
      openBlockers: 1,
      deliverablesProduced: 1,
      deadlineRisk: "overdue",
    });
  });
});
