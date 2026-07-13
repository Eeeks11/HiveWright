import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, it, expect, beforeEach } from "vitest";
import { claimNextTask, completeTask, releaseTask } from "@/dispatcher/task-claimer";
import { startPipelineRun } from "@/pipelines/service";
import { ANALYST_OUTPUT_DISPOSITION_KIND } from "@/tasks/output-disposition";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('claimer-test-biz', 'Claimer Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('claimer-test-role', 'CT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("claimNextTask", () => {
  it("does not claim pending work for goals paused by budget", async () => {
    const [goal] = await sql`
      INSERT INTO goals (
        hive_id,
        title,
        status,
        budget_cents,
        spent_cents,
        budget_state,
        budget_enforced_at,
        budget_enforcement_reason
      )
      VALUES (
        ${bizId},
        'paused-budget-goal',
        'paused',
        1000,
        1000,
        'paused',
        NOW(),
        'Paused by budget'
      )
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-budget-paused', 'Brief', ${goal.id})
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task).toBeNull();
  });

  it("pauses and skips pending work when recorded goal spend is already at budget cap", async () => {
    const [goal] = await sql`
      INSERT INTO goals (
        hive_id,
        title,
        status,
        budget_cents,
        spent_cents,
        budget_state
      )
      VALUES (
        ${bizId},
        'stale-active-over-budget-goal',
        'active',
        1000,
        1000,
        'ok'
      )
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-budget-over-cap', 'Brief', ${goal.id})
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task).toBeNull();

    const [updatedGoal] = await sql`
      SELECT status, budget_state, budget_enforced_at, budget_enforcement_reason
      FROM goals
      WHERE id = ${goal.id}
    `;
    expect(updatedGoal.status).toBe("paused");
    expect(updatedGoal.budget_state).toBe("paused");
    expect(updatedGoal.budget_enforced_at).not.toBeNull();
    expect(updatedGoal.budget_enforcement_reason).toBe("Paused by budget");
  });

  it("does not claim pending work when the hive is creation-paused", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-hive-paused', 'Brief')
    `;
    await sql`
      INSERT INTO hive_runtime_locks (hive_id, creation_paused, reason, paused_by)
      VALUES (${bizId}, true, 'Paused by AI spend budget breach', 'system:ai-budget')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task).toBeNull();
  });

  it("claims a pending task atomically", async () => {
    // Insert with future retry_after so the live dispatcher skips it
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-1', 'Do it', 5, NOW() + INTERVAL '1 hour')
    `;
    // Clear retry_after and immediately claim — dispatcher won't be notified of the update
    await sql`UPDATE tasks SET retry_after = NULL WHERE title = 'claimer-test-1' AND status = 'pending'`;

    const task = await claimNextTask(sql, process.pid);
    expect(task).not.toBeNull();
    expect(task!.title).toBe("claimer-test-1");
    expect(task!.status).toBe("active");
  });

  it("returns null when no pending tasks", async () => {
    // No test tasks inserted, so only stray tasks from the dispatcher could be pending.
    // Insert and immediately claim a canary to flush the queue state, then verify null.
    const task = await claimNextTask(sql, process.pid);
    // If dispatcher left a stray pending task, we might get it — that's OK,
    // re-check after clearing to verify the "no pending" path:
    if (task) {
      await sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${task.id}`;
    }
    const task2 = await claimNextTask(sql, process.pid);
    expect(task2).toBeNull();
  });

  it("claims highest priority first (lowest number)", async () => {
    // Insert with future retry_after so the live dispatcher skips them
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, retry_after)
      VALUES
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-low', 'Low', 10, NOW() + INTERVAL '1 hour'),
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-high', 'High', 1, NOW() + INTERVAL '1 hour')
    `;
    // Clear retry_after on both and immediately claim
    await sql`UPDATE tasks SET retry_after = NULL WHERE title LIKE 'claimer-test-%' AND status = 'pending'`;

    const task = await claimNextTask(sql, process.pid);
    expect(task!.title).toBe("claimer-test-high");
  });

  it("does not claim a second task for a role that already has an active task", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-busy-active', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-blocked-by-busy', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    if (task) {
      expect(task.title).not.toBe("claimer-test-blocked-by-busy");
    }
  });

  it("uses the schema default limit of one when a role omits concurrency_limit", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('claimer-default-limit-role', 'CT Default Limit', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-default-limit-role', 'owner', 'claimer-default-limit-active', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-default-limit-role', 'owner', 'claimer-default-limit-pending', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    if (task) {
      expect(task.title).not.toBe("claimer-default-limit-pending");
    }
  });

  it("atomically allows only one concurrent claim for a role with limit one", async () => {
    await sql`
      UPDATE role_templates
      SET concurrency_limit = 1
      WHERE slug = 'claimer-test-role'
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority)
      VALUES
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-race-1', 'Brief', 1),
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-race-2', 'Brief', 2)
    `;

    // Delay the first active transition long enough for the second reserved DB
    // connection to enter claimNextTask. Without a role-wide lock around the
    // count + claim decision, both connections can lock different pending task
    // rows, observe zero active tasks, and claim both despite limit=1.
    await sql`
      CREATE OR REPLACE FUNCTION claim_next_task_race_delay()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'pending'
           AND NEW.status = 'active'
           AND NEW.title LIKE 'claimer-race-%' THEN
          PERFORM pg_sleep(0.25);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`
      CREATE TRIGGER claim_next_task_race_delay_trigger
      BEFORE UPDATE OF status ON tasks
      FOR EACH ROW
      EXECUTE FUNCTION claim_next_task_race_delay()
    `;

    const testDbUrl =
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgresql://hivewright:***@localhost:5432/hivewrightv2_test";
    const conn1 = postgres(testDbUrl, { max: 1 });
    const conn2 = postgres(testDbUrl, { max: 1 });
    let releaseStart!: () => void;
    const startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const claimFrom = async (conn: typeof conn1, pid: number) => {
      await startBarrier;
      return claimNextTask(conn, pid);
    };

    try {
      const first = claimFrom(conn1, 10101);
      const second = claimFrom(conn2, 20202);
      releaseStart();
      const results = await Promise.all([first, second]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((task) => task?.assignedTo === "claimer-test-role")).toHaveLength(1);

      const [counts] = await sql<{ active_count: number; pending_count: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
        FROM tasks
        WHERE title LIKE 'claimer-race-%'
      `;
      expect(counts).toEqual({ active_count: 1, pending_count: 1 });
    } finally {
      await conn1.end({ timeout: 5 });
      await conn2.end({ timeout: 5 });
      await sql`DROP TRIGGER IF EXISTS claim_next_task_race_delay_trigger ON tasks`;
      await sql`DROP FUNCTION IF EXISTS claim_next_task_race_delay()`;
    }
  });

  it("re-checks active role counts after candidate discovery under a fresh role lock snapshot", async () => {
    await sql`
      UPDATE role_templates
      SET concurrency_limit = 1
      WHERE slug = 'claimer-test-role'
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority)
      VALUES
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-stale-snapshot-1', 'Brief', 1),
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-stale-snapshot-2', 'Brief', 2)
    `;

    const task = await claimNextTask(sql, 30303, {
      afterCandidateRolesSelected: async (_tx, roles) => {
        expect(roles.map((role) => role.assignedTo)).toContain("claimer-test-role");
        await sql`
          UPDATE tasks
          SET status = 'active', started_at = NOW(), dispatcher_pid = 40404, updated_at = NOW()
          WHERE title = 'claimer-stale-snapshot-1'
        `;
      },
    });

    expect(task).toBeNull();

    const [counts] = await sql<{ active_count: number; pending_count: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
      FROM tasks
      WHERE title LIKE 'claimer-stale-snapshot-%'
    `;
    expect(counts).toEqual({ active_count: 1, pending_count: 1 });
  });

  it("does claim a second task for a different role", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('claimer-test-role-other', 'CT Other', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-busy-active-2', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role-other', 'owner', 'claimer-test-other-role', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task?.title).toBe("claimer-test-other-role");
  });

  it("allows a second goal-supervisor task even when one is active", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, concurrency_limit)
      VALUES ('goal-supervisor', 'Supervisor', 'system', 'claude-code', 50)
      ON CONFLICT (slug) DO UPDATE SET concurrency_limit = 50
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'goal-supervisor', 'dispatcher', 'sup-active', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'goal-supervisor', 'dispatcher', 'sup-pending-allowed', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task?.title).toBe("sup-pending-allowed");
  });

  it("skips tasks with future retry_after", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-retry', 'Retry later', NOW() + INTERVAL '1 hour')
    `;

    const task = await claimNextTask(sql, process.pid);
    // The task has retry_after in the future, so it should be skipped.
    // If a stray non-test task gets claimed, that's OK — we just need to verify
    // our test task was NOT the one claimed.
    if (task) {
      expect(task.title).not.toBe("claimer-test-retry");
    }
  });
});

describe("releaseTask", () => {
  it("sets task back to pending with retry_after and increments retry_count", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-release', 'Brief', 'active')
      RETURNING *
    `;

    await releaseTask(sql, inserted.id, 60);

    const [updated] = await sql`SELECT status, retry_count, retry_after FROM tasks WHERE id = ${inserted.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.retry_count).toBe(1);
    expect(updated.retry_after).not.toBeNull();
  });
});

describe("completeTask", () => {
  it("marks the task completed and clears stale failure_reason", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-complete', 'Brief', 'active', 'Reached maximum turn limit')
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Recovered after retry");

    const [updated] = await sql`
      SELECT status, result_summary, failure_reason, completed_at
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.result_summary).toBe("Recovered after retry");
    expect(updated.failure_reason).toBeNull();
    expect(updated.completed_at).not.toBeNull();
  });

  it("marks the task completed and preserves explicit runtime warnings", async () => {
    const warning = "Codex rollout registration failed after agent output was captured; HiveWright persisted stdout directly.";
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-complete-warning', 'Brief', 'active', 'Reached maximum turn limit')
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Recovered after retry", { runtimeWarnings: [warning] });

    const [updated] = await sql`
      SELECT status, result_summary, failure_reason, completed_at
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.result_summary).toBe("Recovered after retry");
    expect(updated.failure_reason).toBe(warning);
    expect(updated.completed_at).not.toBeNull();
  });
  it("marks the task completed and records canonical disposition for GitHub routing publication output", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (
        ${bizId},
        'claimer-test-role',
        'owner',
        'Publish prior findings to GitHub',
        'Route prior analyst findings to a GitHub issue or record why no follow-up is needed.',
        'active'
      )
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Published prior findings to GitHub issue #191 with verification evidence.");

    const [updated] = await sql`
      SELECT status, terminal_disposition
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.terminal_disposition).toMatchObject({
      kind: ANALYST_OUTPUT_DISPOSITION_KIND,
      terminal: true,
      final_disposition_label: "github_issue_backlog_open",
      evidence: { disposition: "github_route", githubRefs: expect.arrayContaining(["GitHub issue #191"]) },
    });
  });

  it("rejects routing publication completion without route or terminal disposition evidence", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (
        ${bizId},
        'claimer-test-role',
        'owner',
        'Publish prior findings to GitHub',
        'Route prior analyst findings to a GitHub issue or record why no follow-up is needed.',
        'active'
      )
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Prepared a summary of prior findings but did not publish or close out routing.");

    const [updated] = await sql`
      SELECT status, failure_reason, completed_at, terminal_disposition
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("failed");
    expect(updated.failure_reason).toContain("Routing/publication task completion rejected");
    expect(updated.completed_at).toBeNull();
    expect(updated.terminal_disposition).toBeNull();
  });

  it("rejects routing publication completion when disposition evidence exists only in task instructions", async () => {
    const instructionOnlyBriefs = [
      "Route prior analyst findings to a GitHub issue. Example accepted output: Published to GitHub issue #191.",
      "Route prior analyst findings or record an explicit no-follow-up terminal disposition if no action is needed.",
    ];

    for (const [index, brief] of instructionOnlyBriefs.entries()) {
      const [inserted] = await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
        VALUES (
          ${bizId},
          'claimer-test-role',
          'owner',
          ${`Publish prior findings to GitHub ${index}`},
          ${brief},
          'active'
        )
        RETURNING *
      `;

      await completeTask(sql, inserted.id, "Prepared routing notes.");

      const [updated] = await sql`
        SELECT status, failure_reason, completed_at, terminal_disposition
        FROM tasks WHERE id = ${inserted.id}
      `;
      expect(updated.status).toBe("failed");
      expect(updated.failure_reason).toContain("Routing/publication task completion rejected");
      expect(updated.completed_at).toBeNull();
      expect(updated.terminal_disposition).toBeNull();
    }
  });

  it("blocks deployment-sensitive direct completion when live runtime hash lacks the expected commit", async () => {
    const previousHash = process.env.HIVEWRIGHT_BUILD_HASH;
    process.env.HIVEWRIGHT_BUILD_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try {
      const [project] = await sql<{ id: string }[]>`
        INSERT INTO projects (hive_id, slug, name, git_repo)
        VALUES (${bizId}, 'claimer-deploy-sensitive', 'Claimer Deploy Sensitive', true)
        RETURNING id
      `;
      const [inserted] = await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, project_id)
        VALUES (
          ${bizId},
          'claimer-test-role',
          'owner',
          'Deploy dashboard fix',
          'Deploy the fix to the live operational checkout and prove the same build is running.',
          'active',
          ${project.id}
        )
        RETURNING *
      `;

      await completeTask(sql, inserted.id, "Expected commit 36cb96c passed focused tests in task worktree.");

      const [updated] = await sql`
        SELECT status, result_summary, failure_reason, completed_at
        FROM tasks WHERE id = ${inserted.id}
      `;
      expect(updated.status).toBe("blocked");
      expect(updated.result_summary).toBeNull();
      expect(updated.completed_at).toBeNull();
      expect(updated.failure_reason).toContain("Deployment-sensitive completion blocked");
      expect(updated.failure_reason).toContain("Current runtime build hash");
    } finally {
      if (previousHash === undefined) delete process.env.HIVEWRIGHT_BUILD_HASH;
      else process.env.HIVEWRIGHT_BUILD_HASH = previousHash;
    }
  });
});

async function seedTwoStepPipelineForClaimedTask() {
  const [template] = await sql<{ id: string }[]>`
    INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
    VALUES ('hive', ${bizId}, 'claimer-test-pipeline', 'Claimer Test Pipeline', 'engineering', ${sql.json({ artifactKind: "handoff", requiredFields: ["summary", "verification"] })}, 1, true)
    RETURNING id
  `;
  const steps = await sql<{ id: string; step_order: number }[]>`
    INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, qa_required, output_contract, acceptance_criteria, drift_check)
    VALUES
      (${template.id}, 1, 'build', 'Build', 'claimer-test-role', 'Build the requested item.', false, ${sql.json({ artifactKind: "build", requiredFields: ["summary", "verification"] })}, 'Build must satisfy the source request.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })}),
      (${template.id}, 2, 'review', 'Review', 'claimer-test-role', 'Review the requested item.', true, ${sql.json({ artifactKind: "review", requiredFields: ["verdict", "evidence"] })}, 'Review must produce a verdict.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })})
    RETURNING id, step_order
  `;

  return { templateId: template.id, firstStepId: steps[0].id, secondStepId: steps[1].id };
}

describe("completeTask pipeline advancement", () => {
  it("advances a pipeline-created task and creates the next step task", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, `summary: Build completed through dispatcher path.
verification: unit checked.`);

    const stepRuns = await sql<{ step_id: string; task_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, task_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;
    const [run] = await sql<{ status: string; current_step_id: string }[]>`
      SELECT status, current_step_id FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [nextTask] = await sql<{ assigned_to: string; parent_task_id: string | null; qa_required: boolean }[]>`
      SELECT assigned_to, parent_task_id, qa_required FROM tasks WHERE id = ${stepRuns[1].task_id}
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: pipeline.firstStepId, task_id: started.taskId, status: "complete", result_summary: `summary: Build completed through dispatcher path.
verification: unit checked.` });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending" });
    expect(run).toEqual({ status: "active", current_step_id: pipeline.secondStepId });
    expect(nextTask).toEqual({ assigned_to: "claimer-test-role", parent_task_id: started.taskId, qa_required: true });
  });

  it("does not let a late retry-cap failure overwrite a completed and advanced pipeline step", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    await sql`UPDATE pipeline_steps SET max_retries = 0 WHERE id = ${pipeline.firstStepId}`;
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, `summary: Build completed through dispatcher path.
verification: unit checked.`);
    await releaseTask(sql, started.taskId, 60, "Late retry-cap failure should not overwrite completion.");

    const stepRuns = await sql<{ step_id: string; task_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, task_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;
    const [run] = await sql<{ status: string; current_step_id: string; supervisor_handoff: string | null }[]>`
      SELECT status, current_step_id, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [sourceTask] = await sql<{ status: string; result_summary: string | null; failure_reason: string | null }[]>`
      SELECT status, result_summary, failure_reason FROM tasks WHERE id = ${started.taskId}
    `;
    const [nextTask] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${stepRuns[1].task_id}
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({
      step_id: pipeline.firstStepId,
      task_id: started.taskId,
      status: "complete",
      result_summary: `summary: Build completed through dispatcher path.
verification: unit checked.`,
    });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending", result_summary: null });
    expect(run).toEqual({ status: "active", current_step_id: pipeline.secondStepId, supervisor_handoff: null });
    expect(sourceTask).toEqual({
      status: "completed",
      result_summary: `summary: Build completed through dispatcher path.
verification: unit checked.`,
      failure_reason: null,
    });
    expect(nextTask).toEqual({ status: "pending", failure_reason: null });
  });

  it("advances when required output fields are markdown bold labels", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, `**summary**
Build completed through dispatcher path.

**verification**
Unit checked and source request preserved.`);

    const stepRuns = await sql<{ step_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;
    const [run] = await sql<{ status: string; current_step_id: string }[]>`
      SELECT status, current_step_id FROM pipeline_runs WHERE id = ${started.runId}
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: pipeline.firstStepId, status: "complete" });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending" });
    expect(run).toEqual({ status: "active", current_step_id: pipeline.secondStepId });
  });

  it("does not create pipeline rows when completing a non-pipeline task", async () => {
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'flat-task', 'Flat task', 'active')
      RETURNING id
    `;

    await completeTask(sql, inserted.id, "Flat task complete.");

    const [counts] = await sql<{ runs: number; step_runs: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM pipeline_runs) AS runs,
        (SELECT COUNT(*)::int FROM pipeline_step_runs) AS step_runs
    `;
    expect(counts).toEqual({ runs: 0, step_runs: 0 });
  });



  it("marks a claimed pipeline step as running", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    const claimed = await claimNextTask(sql, process.pid);
    expect(claimed?.id).toBe(started.taskId);

    const [stepRun] = await sql<{ status: string }[]>`
      SELECT status FROM pipeline_step_runs WHERE task_id = ${started.taskId}
    `;
    expect(stepRun.status).toBe("running");
  });

  it("fails the pipeline cleanly when output contract fields are missing", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, "I did some work but did not provide the required labels.");

    const [run] = await sql<{ status: string; supervisor_handoff: string | null }[]>`
      SELECT status, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [stepRun] = await sql<{ status: string; result_summary: string | null }[]>`
      SELECT status, result_summary FROM pipeline_step_runs WHERE task_id = ${started.taskId}
    `;
    const [task] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${started.taskId}
    `;

    expect(run.status).toBe("failed");
    expect(run.supervisor_handoff).toContain("Pipeline output contract failed");
    expect(stepRun.status).toBe("failed");
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toContain("missing required field");
  });

  it("fails the pipeline cleanly when a routing publication step lacks route disposition evidence", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });
    await sql`
      UPDATE tasks
      SET
        title = 'Publish prior findings to GitHub',
        brief = 'Route prior analyst findings to a GitHub issue or record why no follow-up is needed.'
      WHERE id = ${started.taskId}
    `;

    await completeTask(sql, started.taskId, `summary: Reviewed existing work for the routing pipeline handoff but left publication unresolved.
verification: Checked notes only; no route or terminal closeout evidence recorded.`);

    const [run] = await sql<{ status: string; supervisor_handoff: string | null }[]>`
      SELECT status, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [stepRun] = await sql<{ status: string; result_summary: string | null }[]>`
      SELECT status, result_summary FROM pipeline_step_runs WHERE task_id = ${started.taskId}
    `;
    const [task] = await sql<{ status: string; failure_reason: string | null; completed_at: Date | null }[]>`
      SELECT status, failure_reason, completed_at FROM tasks WHERE id = ${started.taskId}
    `;

    expect(task.status).toBe("failed");
    expect(task.completed_at).toBeNull();
    expect(task.failure_reason).toContain("Routing/publication task completion rejected");
    expect(stepRun.status).toBe("failed");
    expect(stepRun.result_summary).toContain("Routing/publication task completion rejected");
    expect(run.status).toBe("failed");
    expect(run.supervisor_handoff).toContain("Routing/publication task completion rejected");
  });

  it("fails the pipeline cleanly when schema-valid output drifts from original source task intent", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    await sql`
      UPDATE pipeline_steps
      SET output_contract = ${sql.json({
        artifactKind: "build",
        requiredFields: ["summary", "verification", "status"],
        schema: {
          type: "object",
          required: ["summary", "verification", "status"],
          properties: {
            summary: { type: "string" },
            verification: { type: "array", items: { type: "string" } },
            status: { enum: ["pass", "fail"] },
          },
        },
      })}
      WHERE id = ${pipeline.firstStepId}
    `;
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'HiveWright blog post request', 'Write about HiveWright autonomous business operations and content strategy.', NOW() + INTERVAL '1 hour')
      RETURNING id
    `;
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "fallback source context",
      sourceTaskId: sourceTask.id,
    });

    await completeTask(sql, started.taskId, JSON.stringify({
      summary: "Prepared a frontend baseline implementation plan for responsive navigation.",
      verification: ["reviewed component tree"],
      status: "pass",
    }));

    const [run] = await sql<{ status: string; supervisor_handoff: string | null }[]>`
      SELECT status, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [task] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${started.taskId}
    `;

    expect(run.status).toBe("failed");
    expect(run.supervisor_handoff).toContain("source intent");
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toContain("source intent");
  });

  it("fails the pipeline instead of retrying when step retry cap is reached", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    await sql`UPDATE pipeline_steps SET max_retries = 0 WHERE id = ${pipeline.firstStepId}`;
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await releaseTask(sql, started.taskId, 60, "Pipeline step runtime exceeded configured max runtime.");

    const [run] = await sql<{ status: string; supervisor_handoff: string | null }[]>`
      SELECT status, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [task] = await sql<{ status: string; retry_count: number; failure_reason: string | null }[]>`
      SELECT status, retry_count, failure_reason FROM tasks WHERE id = ${started.taskId}
    `;

    expect(run.status).toBe("failed");
    expect(run.supervisor_handoff).toContain("runtime exceeded");
    expect(task.status).toBe("failed");
    expect(task.retry_count).toBe(0);
  });

  it("does not advance a pipeline task twice when completion is retried", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, `summary: First completion.
verification: checked.`);
    await completeTask(sql, started.taskId, `summary: Duplicate completion.
verification: checked.`);

    const stepRuns = await sql<{ step_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: pipeline.firstStepId, status: "complete", result_summary: `summary: First completion.
verification: checked.` });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending" });
  });

  it("rolls back task completion when next step-run insertion fails and retries exactly once", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    const injectedDuplicateStepRun = await sql<{ id: string }[]>`
      INSERT INTO pipeline_step_runs (run_id, step_id, status)
      VALUES (${started.runId}, ${pipeline.secondStepId}, 'pending')
      RETURNING id
    `;
    expect(injectedDuplicateStepRun).toHaveLength(1);

    const firstResult = `summary: Completion should roll back.
verification: duplicate step-run blocks advancement.`;
    await expect(completeTask(sql, started.taskId, firstResult)).rejects.toThrow();

    const [rolledBackTask] = await sql<{ status: string; result_summary: string | null; completed_at: Date | null }[]>`
      SELECT status, result_summary, completed_at
      FROM tasks
      WHERE id = ${started.taskId}
    `;
    const [rolledBackStepRun] = await sql<{ status: string; result_summary: string | null; completed_at: Date | null }[]>`
      SELECT status, result_summary, completed_at
      FROM pipeline_step_runs
      WHERE task_id = ${started.taskId}
    `;
    const [rolledBackRun] = await sql<{ status: string; current_step_id: string | null }[]>`
      SELECT status, current_step_id
      FROM pipeline_runs
      WHERE id = ${started.runId}
    `;
    const duplicateNextTasks = await sql<{ id: string }[]>`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${started.taskId}
    `;

    expect(rolledBackTask).toEqual({ status: "pending", result_summary: null, completed_at: null });
    expect(rolledBackStepRun).toEqual({ status: "pending", result_summary: null, completed_at: null });
    expect(rolledBackRun).toEqual({ status: "active", current_step_id: pipeline.firstStepId });
    expect(duplicateNextTasks).toHaveLength(0);

    await sql`
      DELETE FROM pipeline_step_runs
      WHERE id = ${injectedDuplicateStepRun[0].id}
    `;

    const retryResult = `summary: Completion retried safely.
verification: duplicate injection removed.`;
    await completeTask(sql, started.taskId, retryResult);
    await completeTask(sql, started.taskId, `summary: Duplicate retry should be ignored.
verification: checked.`);

    const stepRuns = await sql<{ step_id: string; task_id: string | null; status: string; result_summary: string | null }[]>`
      SELECT step_id, task_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;
    const nextTasks = await sql<{ id: string; status: string }[]>`
      SELECT id, status
      FROM tasks
      WHERE parent_task_id = ${started.taskId}
      ORDER BY created_at ASC
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: pipeline.firstStepId, task_id: started.taskId, status: "complete", result_summary: retryResult });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending" });
    expect(nextTasks).toHaveLength(1);
    expect(stepRuns[1].task_id).toBe(nextTasks[0].id);
  });

  it("documents completion/failure lock ordering for pipeline task races", () => {
    // PostgreSQL deadlock reproduction is timing-sensitive in unit tests. This
    // regression proof pins the invariant that prevents the deadlock reviewed
    // in PR #249: every completion-style transaction locks pipeline_step_runs
    // and pipeline_runs before updating tasks, matching the failure path.
    const taskClaimer = readFileSync("src/dispatcher/task-claimer.ts", "utf8");
    const qaRouter = readFileSync("src/dispatcher/qa-router.ts", "utf8");
    const pipelineService = readFileSync("src/pipelines/service.ts", "utf8");

    const completeTaskBody = taskClaimer.slice(
      taskClaimer.indexOf("export async function completeTask"),
      taskClaimer.indexOf("async function markTaskCompletedInTransaction"),
    );
    expect(completeTaskBody.indexOf("lockPipelineStepRunForTask(tx, taskId)")).toBeLessThan(
      completeTaskBody.indexOf("markTaskCompletedInTransaction(tx"),
    );
    expect(completeTaskBody.indexOf("markTaskCompletedInTransaction(tx")).toBeLessThan(
      completeTaskBody.indexOf("advancePipelineRunFromTaskInTransaction(tx"),
    );

    const qaLockIndex = qaRouter.indexOf("lockPipelineStepRunForTask(tx, taskId)");
    const qaTaskUpdateIndex = qaRouter.indexOf("UPDATE tasks", qaLockIndex);
    const qaAdvanceIndex = qaRouter.indexOf("advancePipelineRunFromTaskInTransaction(tx", qaLockIndex);
    expect(qaLockIndex).toBeGreaterThan(-1);
    expect(qaLockIndex).toBeLessThan(qaTaskUpdateIndex);
    expect(qaTaskUpdateIndex).toBeLessThan(qaAdvanceIndex);

    const lockHelper = pipelineService.slice(
      pipelineService.indexOf("export async function lockPipelineStepRunForTask"),
      pipelineService.indexOf("export async function advancePipelineRunFromTaskInTransaction"),
    );
    expect(lockHelper).toContain("FROM pipeline_step_runs psr");
    expect(lockHelper).toContain("JOIN pipeline_runs pr ON pr.id = psr.run_id");
    expect(lockHelper).toContain("FOR UPDATE OF psr, pr");

    const failureBody = pipelineService.slice(
      pipelineService.indexOf("export async function failPipelineRunFromTask"),
      pipelineService.indexOf("export type PipelineValidationIssue"),
    );
    expect(failureBody.indexOf("UPDATE pipeline_step_runs")).toBeLessThan(
      failureBody.indexOf("UPDATE pipeline_runs"),
    );
    expect(failureBody.indexOf("UPDATE pipeline_runs")).toBeLessThan(
      failureBody.indexOf("UPDATE tasks"),
    );
  });
});
