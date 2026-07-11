import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { runImprovementSweep, suggestCheaperModel } from "@/improvement/sweeper";

const HIVE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'sweep-biz', 'Sweep Test', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('flaky-role', 'Flaky', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("runImprovementSweep", () => {
  it("does not include Haiku in sweeper downgrade suggestions", () => {
    const source = readFileSync("src/improvement/sweeper.ts", "utf8");
    const suggestionBody = source.match(/function suggestCheaperModel[\s\S]*?^}/m)?.[0] ?? "";
    const candidates = [
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "openai-codex/gpt-5.5",
    ].map((modelId) => suggestCheaperModel(modelId));

    expect(candidates.filter((candidate): candidate is string => Boolean(candidate))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/haiku/i)]),
    );
    expect(suggestionBody).not.toMatch(/haiku/i);
  });

  it("proposes a role-evolution decision for high-traffic role memory", async () => {
    await sql`
      INSERT INTO role_memory (hive_id, role_slug, content, confidence, access_count)
      VALUES (
        ${HIVE}, 'flaky-role',
        'Always dry-run before applying migrations in production',
        0.95, 7
      )
    `;

    const [res] = await runImprovementSweep(sql);
    expect(res.hiveId).toBe(HIVE);
    expect(res.evolutionProposals).toBeGreaterThanOrEqual(1);

    const decisions = await sql`
      SELECT title, context, status FROM decisions
      WHERE hive_id = ${HIVE} AND status = 'auto_approved'
    `;
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions.some((d) => (d.title as string).includes("flaky-role"))).toBe(true);

    // Autonomous action: the source memory entry's confidence should now be 1.0.
    const [mem] = await sql`
      SELECT confidence FROM role_memory
      WHERE hive_id = ${HIVE} AND role_slug = 'flaky-role'
    `;
    expect(Number(mem.confidence)).toBe(1);
  });

  it("flags a role with >=40% failure rate as a reliability concern without changing role models", async () => {
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-opus-4-7',
          fallback_model = 'anthropic/claude-sonnet-4-6'
      WHERE slug = 'flaky-role'
    `;
    // 7 failed + 3 completed = 70% failure rate. Seed started_at within window.
    for (let i = 0; i < 7; i++) {
      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief, started_at)
        VALUES (${HIVE}, 'flaky-role', 'owner', 'failed', 5, ${"Fail " + i}, 'b', NOW() - INTERVAL '1 day')
      `;
    }
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief, started_at)
        VALUES (${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Ok " + i}, 'b', NOW() - INTERVAL '1 day')
      `;
    }

    const [res] = await runImprovementSweep(sql);
    expect(res.reliabilityProposals).toBeGreaterThanOrEqual(1);

    const [d] = await sql`
      SELECT title, context FROM decisions
      WHERE hive_id = ${HIVE} AND title LIKE 'Role reliability concern:%'
    `;
    expect(d).toBeDefined();
    expect((d.context as string)).toMatch(/flaky-role/);
    expect((d.context as string)).toMatch(/failure rate/);

    const [role] = await sql`
      SELECT adapter_type, recommended_model, fallback_model
      FROM role_templates
      WHERE slug = 'flaky-role'
    `;
    expect(role.adapter_type).toBe("claude-code");
    expect(role.recommended_model).toBe("anthropic/claude-opus-4-7");
    expect(role.fallback_model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("does not double-propose reliability concerns on a second run", async () => {
    for (let i = 0; i < 7; i++) {
      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief, started_at)
        VALUES (${HIVE}, 'flaky-role', 'owner', 'failed', 5, ${"Fail " + i}, 'b', NOW() - INTERVAL '1 day')
      `;
    }
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief, started_at)
        VALUES (${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Ok " + i}, 'b', NOW() - INTERVAL '1 day')
      `;
    }

    await runImprovementSweep(sql);
    await runImprovementSweep(sql);

    const rows = await sql`
      SELECT COUNT(*)::int AS c FROM decisions
      WHERE hive_id = ${HIVE} AND title = 'Role reliability concern: flaky-role'
    `;
    expect((rows[0] as unknown as { c: number }).c).toBe(1);
  });

  it("ignores roles with fewer than 5 attempts", async () => {
    for (let i = 0; i < 2; i++) {
      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief, started_at)
        VALUES (${HIVE}, 'flaky-role', 'owner', 'failed', 5, ${"Fail " + i}, 'b', NOW() - INTERVAL '1 day')
      `;
    }
    const [res] = await runImprovementSweep(sql);
    expect(res.reliabilityProposals).toBe(0);
  });

  it("logs an efficiency concern without auto-swapping Sonnet to a removed Haiku tier", async () => {
    // Reset the role to sonnet so we can observe the swap.
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-sonnet-4-6',
          fallback_model = NULL
      WHERE slug = 'flaky-role'
    `;
    // 6 completed tasks at 100 cents each on Sonnet — above the $0.50 threshold.
    for (let i = 0; i < 6; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          started_at, cost_cents, model_used, tokens_input, tokens_output
        )
        VALUES (
          ${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Big " + i}, 'b',
          NOW() - INTERVAL '1 day', 100, 'anthropic/claude-sonnet-4-6', 1000, 500
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE}, 'negative', 'explicit_owner_feedback', 'low quality', 1, 4)
      `;
    }
    const [res] = await runImprovementSweep(sql);
    expect(res.efficiencyProposals).toBeGreaterThanOrEqual(1);

    const [d] = await sql`
      SELECT title, status, context FROM decisions
      WHERE hive_id = ${HIVE}
        AND title LIKE 'Model efficiency review:%'
    `;
    expect(d.status).toBe("auto_approved");
    expect((d.context as string)).toMatch(/No role runtime config was changed/);

    const [role] = await sql`
      SELECT recommended_model, fallback_model FROM role_templates WHERE slug = 'flaky-role'
    `;
    expect(role.recommended_model).toBe("anthropic/claude-sonnet-4-6");
    expect(role.fallback_model).toBeNull();
  });

  it("uses model-efficiency thresholds from adapter_config at sweep runtime", async () => {
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-sonnet-4-6',
          fallback_model = NULL
      WHERE slug = 'flaky-role'
    `;
    for (let i = 0; i < 6; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          started_at, cost_cents, model_used, tokens_input, tokens_output
        )
        VALUES (
          ${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Tuned " + i}, 'b',
          NOW() - INTERVAL '1 day', 60, 'anthropic/claude-sonnet-4-6', 1000, 500
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE}, 'negative', 'explicit_owner_feedback', 'low quality', 1, 4)
      `;
    }

    await sql`
      INSERT INTO adapter_config (adapter_type, config)
      VALUES (
        'model-efficiency',
        ${sql.json({
          efficiency_avg_cost_cents_threshold: 75,
          efficiency_min_completions_threshold: 7,
        })}
      )
    `;

    const [strictResult] = await runImprovementSweep(sql);
    expect(strictResult.efficiencyProposals).toBe(0);

    await sql`
      UPDATE adapter_config
      SET config = ${sql.json({
        efficiency_avg_cost_cents_threshold: 50,
        efficiency_min_completions_threshold: 5,
      })},
          updated_at = NOW()
      WHERE adapter_type = 'model-efficiency'
    `;

    const [relaxedResult] = await runImprovementSweep(sql);
    expect(relaxedResult.efficiencyProposals).toBeGreaterThanOrEqual(1);

    const [decision] = await sql`
      SELECT context FROM decisions
      WHERE hive_id = ${HIVE}
        AND title = 'Model efficiency review: flaky-role'
    `;
    expect(decision).toBeDefined();
    expect(decision.context as string).toContain("average of $0.60/task");
  });

  it("does not demote when composite quality is above the applicable floor", async () => {
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-sonnet-4-6',
          fallback_model = NULL
      WHERE slug = 'flaky-role'
    `;
    for (let i = 0; i < 6; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          started_at, cost_cents, model_used
        )
        VALUES (
          ${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Strong " + i}, 'b',
          NOW() - INTERVAL '1 day', 100, 'anthropic/claude-sonnet-4-6'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE}, 'positive', 'explicit_owner_feedback', 'great', 1, 9)
      `;
    }

    const [res] = await runImprovementSweep(sql);

    expect(res.efficiencyProposals).toBe(0);
    const [role] = await sql`
      SELECT recommended_model FROM role_templates WHERE slug = 'flaky-role'
    `;
    expect(role.recommended_model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("exempts owner-pinned roles from automatic sweeper swaps", async () => {
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-sonnet-4-6',
          fallback_model = NULL,
          owner_pinned = true
      WHERE slug = 'flaky-role'
    `;
    for (let i = 0; i < 6; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          started_at, cost_cents, model_used
        )
        VALUES (
          ${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Pinned " + i}, 'b',
          NOW() - INTERVAL '1 day', 100, 'anthropic/claude-sonnet-4-6'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE}, 'negative', 'explicit_owner_feedback', 'low quality', 1, 3)
      `;
    }

    const [res] = await runImprovementSweep(sql);

    expect(res.efficiencyProposals).toBe(0);
    const [role] = await sql`
      SELECT recommended_model FROM role_templates WHERE slug = 'flaky-role'
    `;
    expect(role.recommended_model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("records an efficiency concern without demoting roles or creating new swap watches", async () => {
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-opus-4-7',
          fallback_model = NULL,
          owner_pinned = false
      WHERE slug = 'flaky-role'
    `;
    for (let i = 0; i < 6; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          started_at, completed_at, cost_cents, model_used
        )
        VALUES (
          ${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Initial bad " + i}, 'b',
          NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', 100, 'anthropic/claude-opus-4-7'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE}, 'negative', 'explicit_owner_feedback', 'low quality', 1, 3)
      `;
    }

    await runImprovementSweep(sql);

    const [role] = await sql`
      SELECT recommended_model, fallback_model FROM role_templates WHERE slug = 'flaky-role'
    `;
    expect(role.recommended_model).toBe("anthropic/claude-opus-4-7");
    expect(role.fallback_model).toBeNull();

    const [watchCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM role_model_swap_watches WHERE hive_id = ${HIVE}
    `;
    expect(watchCount.count).toBe(0);
  });

  it("marks legacy watched swaps failed without mutating role runtime config", async () => {
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-sonnet-4-6',
          fallback_model = 'anthropic/claude-opus-4-7',
          owner_pinned = false
      WHERE slug = 'flaky-role'
    `;
    await sql`
      INSERT INTO role_model_swap_watches (hive_id, role_slug, from_model, to_model, tasks_to_watch, quality_floor, created_at)
      VALUES (${HIVE}, 'flaky-role', 'anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6', 5, 0.7, NOW() - INTERVAL '1 second')
    `;

    for (let i = 0; i < 5; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          started_at, completed_at, cost_cents, model_used
        )
        VALUES (
          ${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Watched bad " + i}, 'b',
          NOW(), NOW(), 10, 'anthropic/claude-sonnet-4-6'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE}, 'negative', 'explicit_owner_feedback', 'still low', 1, 2)
      `;
    }

    const sweep = await runImprovementSweep(sql);
    expect(sweep[0].errors).toEqual([]);

    const [role] = await sql`
      SELECT recommended_model, fallback_model FROM role_templates WHERE slug = 'flaky-role'
    `;
    expect(role.recommended_model).toBe("anthropic/claude-sonnet-4-6");
    expect(role.fallback_model).toBe("anthropic/claude-opus-4-7");

    const [watch] = await sql`
      SELECT status, tasks_seen FROM role_model_swap_watches WHERE hive_id = ${HIVE}
    `;
    expect(watch.status).toBe("failed");
    expect(watch.tasks_seen).toBe(5);

    const [decision] = await sql`
      SELECT title, status, priority FROM decisions
      WHERE hive_id = ${HIVE}
        AND kind = 'model_swap_watch_failed'
    `;
    expect(decision.title).toBe("Model swap watch failed: flaky-role");
    expect(decision.status).toBe("pending");
    expect(decision.priority).toBe("normal");
  });

  it("passes a legacy watched swap when the 5 post-swap tasks are above floor", async () => {
    await sql`
      UPDATE role_templates
      SET recommended_model = 'anthropic/claude-sonnet-4-6',
          fallback_model = 'anthropic/claude-opus-4-7',
          owner_pinned = false
      WHERE slug = 'flaky-role'
    `;
    await sql`
      INSERT INTO role_model_swap_watches (hive_id, role_slug, from_model, to_model, tasks_to_watch, quality_floor, created_at)
      VALUES (${HIVE}, 'flaky-role', 'anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6', 5, 0.7, NOW() - INTERVAL '1 second')
    `;

    for (let i = 0; i < 5; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          started_at, completed_at, cost_cents, model_used
        )
        VALUES (
          ${HIVE}, 'flaky-role', 'owner', 'completed', 5, ${"Watched good " + i}, 'b',
          NOW(), NOW(), 10, 'anthropic/claude-sonnet-4-6'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE}, 'positive', 'explicit_owner_feedback', 'recovered', 1, 9)
      `;
    }

    await runImprovementSweep(sql);

    const [role] = await sql`
      SELECT recommended_model, fallback_model FROM role_templates WHERE slug = 'flaky-role'
    `;
    expect(role.recommended_model).toBe("anthropic/claude-sonnet-4-6");
    expect(role.fallback_model).toBe("anthropic/claude-opus-4-7");

    const [watch] = await sql`
      SELECT status, tasks_seen FROM role_model_swap_watches WHERE hive_id = ${HIVE}
    `;
    expect(watch.status).toBe("passed");
    expect(watch.tasks_seen).toBe(5);

    const [failed] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM decisions
      WHERE hive_id = ${HIVE}
        AND kind = 'model_swap_watch_failed'
    `;
    expect(failed.count).toBe(0);
  });
});
