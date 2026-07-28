import { describe, it, expect, beforeEach } from "vitest";
import { AGENT_AUDIT_EVENTS } from "@/audit/agent-events";
import {
  findStuckTasks,
  findDeadEndReviewTasks,
  findStuckBlockedTasks,
  recoverDiskPressureBlockedTasks,
  recoverInterruptedActiveTasks,
} from "@/dispatcher/watchdog";
import { handleTaskFailureAndDoctor, FailureCategory } from "@/dispatcher/failure-handler";
import { DEFAULT_CONFIG } from "@/dispatcher/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('watchdog-test-biz', 'Watchdog Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('watchdog-test-role', 'WT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});


describe("recoverInterruptedActiveTasks", () => {
  it("requeues active tasks owned by a dead dispatcher pid without consuming a retry", async () => {
    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status,
        dispatcher_pid, started_at, last_heartbeat, retry_count
      )
      VALUES (
        ${bizId}, 'watchdog-test-role', 'owner', 'watchdog-test-dead-pid', 'Brief', 'active',
        424242, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', 2
      )
      RETURNING id
    `;

    const recovered = await recoverInterruptedActiveTasks(sql, 123, (pid) => pid !== 424242);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].title).toBe("watchdog-test-dead-pid");

    const [updated] = await sql`
      SELECT status, retry_count, dispatcher_pid, started_at, last_heartbeat, failure_reason
      FROM tasks
      WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("pending");
    expect(updated.retry_count).toBe(2);
    expect(updated.dispatcher_pid).toBeNull();
    expect(updated.started_at).toBeNull();
    expect(updated.last_heartbeat).toBeNull();
    expect(updated.failure_reason).toContain("dispatcher lifecycle recovery");
  });

  it("leaves active tasks alone when their dispatcher pid is still alive", async () => {
    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status,
        dispatcher_pid, started_at, last_heartbeat
      )
      VALUES (
        ${bizId}, 'watchdog-test-role', 'owner', 'watchdog-test-live-pid', 'Brief', 'active',
        515151, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes'
      )
      RETURNING id
    `;

    const recovered = await recoverInterruptedActiveTasks(sql, 123, () => true);
    expect(recovered).toEqual([]);

    const [updated] = await sql`
      SELECT status, dispatcher_pid
      FROM tasks
      WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("active");
    expect(updated.dispatcher_pid).toBe(515151);
  });
});

describe("findStuckTasks", () => {
  it("finds tasks with stale heartbeat", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, last_heartbeat)
      VALUES (${bizId}, 'watchdog-test-role', 'owner', 'watchdog-test-stuck', 'Brief', 'active',
        NOW() - INTERVAL '10 minutes')
    `;

    const stuck = await findStuckTasks(sql, 300_000); // 5 min timeout
    expect(stuck.length).toBeGreaterThanOrEqual(1);
    expect(stuck.some((t) => t.title === "watchdog-test-stuck")).toBe(true);
  });

  it("finds active tasks with no heartbeat (started long ago)", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, started_at, last_heartbeat)
      VALUES (${bizId}, 'watchdog-test-role', 'owner', 'watchdog-test-nobeat', 'Brief', 'active',
        NOW() - INTERVAL '10 minutes', NULL)
    `;

    const stuck = await findStuckTasks(sql, 300_000);
    expect(stuck.some((t) => t.title === "watchdog-test-nobeat")).toBe(true);
  });

  it("does not flag tasks with recent heartbeat", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, last_heartbeat)
      VALUES (${bizId}, 'watchdog-test-role', 'owner', 'watchdog-test-ok', 'Brief', 'active', NOW())
    `;

    const stuck = await findStuckTasks(sql, 300_000);
    expect(stuck.some((t) => t.title === "watchdog-test-ok")).toBe(false);
  });

  it("flags tasks past max runtime even with fresh heartbeats", async () => {
    // The real-world stuck-task case: agent emits stderr periodically
    // (heartbeat looks alive) but task never actually finishes. Started
    // 3 hours ago — well past the 2-hour max runtime cap.
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status,
                         started_at, last_heartbeat)
      VALUES (${bizId}, 'watchdog-test-role', 'owner', 'watchdog-test-zombie', 'Brief', 'active',
              NOW() - INTERVAL '3 hours', NOW())
    `;

    const stuck = await findStuckTasks(sql, 300_000, 7_200_000);
    const zombie = stuck.find((t) => t.title === "watchdog-test-zombie");
    expect(zombie).toBeDefined();
    expect(zombie?.reason).toBe("max_runtime_exceeded");
  });



  it("uses pipeline step max runtime over the global dispatcher runtime", async () => {
    const [template] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
      VALUES ('hive', ${bizId}, 'watchdog-pipeline-runtime', 'Watchdog Pipeline Runtime', 'engineering', ${sql.json({ artifactKind: "handoff", requiredFields: ["summary"] })}, 1, true)
      RETURNING id
    `;
    const [step] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, output_contract, acceptance_criteria, drift_check)
      VALUES (${template.id}, 1, 'bounded', 'Bounded', 'watchdog-test-role', 'Do bounded work.', false, 60, 0, ${sql.json({ artifactKind: "result", requiredFields: ["summary"] })}, 'Must finish quickly.', ${sql.json({ mode: "source_similarity" })})
      RETURNING id
    `;
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_runs (hive_id, template_id, template_version, status, current_step_id)
      VALUES (${bizId}, ${template.id}, 1, 'active', ${step.id})
      RETURNING id
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, started_at, last_heartbeat)
      VALUES (${bizId}, 'watchdog-test-role', 'pipeline', 'watchdog-pipeline-runtime', 'Brief', 'active', NOW() - INTERVAL '2 minutes', NOW())
      RETURNING id
    `;
    await sql`
      INSERT INTO pipeline_step_runs (run_id, step_id, task_id, status)
      VALUES (${run.id}, ${step.id}, ${task.id}, 'running')
    `;

    const stuck = await findStuckTasks(sql, 300_000, 7_200_000);
    const hit = stuck.find((t) => t.title === "watchdog-pipeline-runtime");
    expect(hit).toBeDefined();
    expect(hit?.reason).toBe("max_runtime_exceeded");
  });

  it("does not flag a long-running task when maxRuntime is disabled (0)", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status,
                         started_at, last_heartbeat)
      VALUES (${bizId}, 'watchdog-test-role', 'owner', 'watchdog-test-runtime-off', 'Brief', 'active',
              NOW() - INTERVAL '12 hours', NOW())
    `;

    const stuck = await findStuckTasks(sql, 300_000, 0);
    expect(stuck.some((t) => t.title === "watchdog-test-runtime-off")).toBe(false);
  });
});

describe("findDeadEndReviewTasks", () => {
  it("flags an in_review parent whose [QA] Review child is blocked", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${bizId}, 'wd dead-end goal', 'active')
      RETURNING id
    `;
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, goal_id)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-dead-end-parent', 'Brief', 'in_review', ${goal.id})
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, failure_reason)
      VALUES (${bizId}, 'qa', 'dispatcher', '[QA] Review: wd-dead-end-parent', 'qa', 'blocked', ${parent.id}, 'env var missing')
    `;

    const found = await findDeadEndReviewTasks(sql);
    const hit = found.find((t) => t.id === parent.id);
    expect(hit).toBeDefined();
    expect(hit?.failedQaReason).toContain("env var missing");
  });

  it("ignores in_review tasks with no [QA] Review child or with a still-open one", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${bizId}, 'wd healthy goal', 'active')
      RETURNING id
    `;
    const [healthyParent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, goal_id)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-healthy-parent', 'Brief', 'in_review', ${goal.id})
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${bizId}, 'qa', 'dispatcher', '[QA] Review: wd-healthy-parent', 'qa', 'active', ${healthyParent.id})
    `;

    const found = await findDeadEndReviewTasks(sql);
    expect(found.some((t) => t.id === healthyParent.id)).toBe(false);
  });

  it("uses the most recent [QA] Review child when multiple exist", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${bizId}, 'wd retried goal', 'active')
      RETURNING id
    `;
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, goal_id)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-retried-parent', 'Brief', 'in_review', ${goal.id})
      RETURNING id
    `;
    // older QA child completed (irrelevant), newer one is failed
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, created_at)
      VALUES (${bizId}, 'qa', 'dispatcher', '[QA] Review: wd-retried-parent', 'qa', 'completed', ${parent.id}, NOW() - INTERVAL '1 hour')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, failure_reason, created_at)
      VALUES (${bizId}, 'qa', 'dispatcher', '[QA] Review: wd-retried-parent', 'qa', 'failed', ${parent.id}, 'second attempt failed', NOW())
    `;

    const found = await findDeadEndReviewTasks(sql);
    const hit = found.find((t) => t.id === parent.id);
    expect(hit?.failedQaReason).toContain("second attempt");
  });
});

describe("findStuckBlockedTasks", () => {
  it("flags blocked tasks older than ageMs with no in-flight child", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, updated_at)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-old-blocked', 'Brief', 'blocked',
              NOW() - INTERVAL '6 hours')
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000); // 4h
    expect(found.some((t) => t.title === "wd-old-blocked")).toBe(true);
  });

  it("does not flag blocked tasks with an active or pending child", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, updated_at)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-blocked-with-repair', 'Brief', 'blocked',
              NOW() - INTERVAL '6 hours')
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${bizId}, 'doctor', 'dispatcher', '[Doctor] Repair env', 'fix', 'active', ${parent.id})
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-with-repair")).toBe(false);
  });

  it("does not flag blocked tasks with a legacy standalone environment-fix task in flight", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, updated_at)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-blocked-with-legacy-env-fix', 'Brief', 'blocked',
              NOW() - INTERVAL '6 hours')
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (
        ${bizId},
        'doctor',
        'doctor',
        ${`Fix environment for: ${parent.id}`},
        'repair runtime',
        'active'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-with-legacy-env-fix")).toBe(false);
  });

  it("does not flag blocked tasks whose environment-fix child already completed after the block", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at
      )
      VALUES (
        ${bizId},
        'dev-agent',
        'owner',
        'wd-blocked-with-completed-env-fix',
        'Brief',
        'blocked',
        'Pre-flight failed: Missing required credential',
        NOW() - INTERVAL '6 minutes'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${bizId},
        'doctor',
        'doctor',
        ${`Fix environment for: ${parent.id}`},
        'repair runtime',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '1 minute'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-with-completed-env-fix")).toBe(false);
  });

  it("does not flag blocked tasks whose non-doctor environment remediation child already completed after the block", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at
      )
      VALUES (
        ${bizId},
        'dev-agent',
        'owner',
        'wd-blocked-with-completed-infra-env-fix',
        'Brief',
        'blocked',
        'Pre-flight failed: Missing required credential',
        NOW() - INTERVAL '6 minutes'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${bizId},
        'infrastructure-agent',
        'goal-supervisor',
        ${`Fix environment for: ${parent.id}`},
        'repair runtime',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '1 minute'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-with-completed-infra-env-fix")).toBe(false);
  });

  it("does not flag blocked tasks when parent updated_at drifted after a completed remediation child", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at
      )
      VALUES (
        ${bizId},
        'dev-agent',
        'owner',
        'wd-blocked-with-drifted-updated-at',
        'Brief',
        'blocked',
        'Pre-flight failed: Missing required credential',
        NOW() - INTERVAL '1 minute'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO agent_audit_events (
        event_type, actor_type, actor_label, hive_id, task_id, target_type, target_id, outcome, metadata, created_at
      )
      VALUES (
        ${AGENT_AUDIT_EVENTS.taskLifecycleTransition},
        'system',
        'test',
        ${bizId},
        ${parent.id},
        'task',
        ${parent.id},
        'success',
        ${sql.json({
          taskId: parent.id,
          previousStatus: "failed",
          nextStatus: "blocked",
          source: "test.watchdog",
        })},
        NOW() - INTERVAL '6 minutes'
      )
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${bizId},
        'infrastructure-agent',
        'goal-supervisor',
        ${`Fix environment for: ${parent.id}`},
        'repair runtime',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '4 minutes'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-with-drifted-updated-at")).toBe(false);
  });

  it("does not flag dispatcher-blocked fast-terminal parents when updated_at drifts after the remediation child completes", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, retry_count, doctor_attempts
      )
      VALUES (
        ${bizId},
        'watchdog-test-role',
        'owner',
        'wd-dispatcher-blocked-drift-anchor',
        'Brief',
        'active',
        0,
        0
      )
      RETURNING id
    `;

    const result = await handleTaskFailureAndDoctor(
      sql,
      parent.id as string,
      FailureCategory.SpawnFailure,
      "Pre-flight failed: Missing required credential",
      DEFAULT_CONFIG,
    );
    expect(result).toBe("environment_fix");

    await sql`
      UPDATE agent_audit_events
      SET created_at = NOW() - INTERVAL '6 minutes'
      WHERE task_id = ${parent.id}
        AND event_type = ${AGENT_AUDIT_EVENTS.taskLifecycleTransition}
        AND COALESCE(metadata->>'nextStatus', '') = 'blocked'
    `;
    await sql`
      UPDATE tasks
      SET status = 'completed',
          updated_at = NOW() - INTERVAL '4 minutes'
      WHERE parent_task_id = ${parent.id}
        AND title = ${`Fix environment for: ${parent.id}`}
    `;
    await sql`
      UPDATE tasks
      SET updated_at = NOW() - INTERVAL '1 minute'
      WHERE id = ${parent.id}
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-dispatcher-blocked-drift-anchor")).toBe(false);
  });

  it("does not flag blocked tasks whose retried environment-fix child already completed after the block", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at
      )
      VALUES (
        ${bizId},
        'dev-agent',
        'owner',
        'wd-blocked-with-completed-retried-env-fix',
        'Brief',
        'blocked',
        'Codex exited code 1: codex reported error',
        NOW() - INTERVAL '6 minutes'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at, adapter_override, model_override
      )
      VALUES (
        ${bizId},
        'doctor',
        'dispatcher',
        ${`[Doctor retry: auto] Fix environment for: ${parent.id}`},
        'repair runtime',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '1 minute',
        'auto',
        'auto'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-with-completed-retried-env-fix")).toBe(false);
  });

  it("still flags blocked tasks when only a completed doctor diagnosis child exists", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at
      )
      VALUES (
        ${bizId},
        'dev-agent',
        'owner',
        'wd-blocked-with-completed-doctor-diagnosis',
        'Brief',
        'blocked',
        'Pre-flight failed: Missing required credential',
        NOW() - INTERVAL '6 minutes'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${bizId},
        'doctor',
        'dispatcher',
        '[Doctor] Diagnose: wd-blocked-with-completed-doctor-diagnosis',
        'diagnose runtime issue',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '1 minute'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-with-completed-doctor-diagnosis")).toBe(true);
  });

  it("still flags blocked tasks if the completed environment-fix task is stale relative to the current block", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at
      )
      VALUES (
        ${bizId},
        'dev-agent',
        'owner',
        'wd-blocked-after-stale-env-fix',
        'Brief',
        'blocked',
        'Pre-flight failed: Missing required credential',
        NOW() - INTERVAL '1 minute'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${bizId},
        'doctor',
        'doctor',
        ${`Fix environment for: ${parent.id}`},
        'repair runtime',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '6 minutes'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 30_000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-blocked-after-stale-env-fix")).toBe(true);
  });

  it("does not flag blocked tasks with an open runtime_guard decision", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-runtime-guard-decision', 'Brief', 'blocked',
              'Runtime guard interrupted repeated read_file calls',
              NOW() - INTERVAL '6 hours')
      RETURNING id
    `;
    await sql`
      INSERT INTO decisions (hive_id, task_id, title, context, recommendation, priority, status, kind)
      VALUES (${bizId}, ${task.id}, 'Runtime guard review', 'context', 'review', 'urgent', 'ea_review', 'runtime_guard')
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-runtime-guard-decision")).toBe(false);
  });

  it("does not flag a recently-blocked task", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, updated_at)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-fresh-blocked', 'Brief', 'blocked', NOW())
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-fresh-blocked")).toBe(false);
  });

  it("does not escalate disk-pressure blocked tasks while waiting for automatic recovery", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (
        ${bizId}, 'dev-agent', 'owner', 'wd-disk-pressure-blocked', 'Brief', 'blocked',
        'disk_pressure_hard_stop: free=20 total=100 ratio=0.0200 hard_bytes=25 hard_ratio=0.08 warning_bytes=50 warning_ratio=0.15',
        NOW() - INTERVAL '6 hours'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    expect(found.some((t) => t.title === "wd-disk-pressure-blocked")).toBe(false);
  });

  it("flags recent terminal adapter/preflight failures without waiting for the generic 240 minute threshold", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (
        ${bizId}, 'image-designer', 'owner', 'wd-fast-image-credential-blocker', 'Brief', 'blocked',
        'Pre-flight failed: Missing required openai-image credential: OPENAI_API_KEY',
        NOW() - INTERVAL '6 minutes'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    const hit = found.find((t) => t.title === "wd-fast-image-credential-blocker");
    expect(hit).toBeDefined();
    expect(hit?.reason).toBe("fast_terminal_failure");
    expect(hit?.blockedSinceMs).toBeLessThan(240 * 60 * 1000);
  });

  it("flags blocked Codex image runtime artifact failures without a 240 minute no-resolving-child hang", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (
        ${bizId}, 'image-designer', 'owner', 'wd-fast-codex-image-artifact-blocker', 'Brief', 'blocked',
        'Codex image runtime completed but no predictable PNG/JPEG artifact path was found.',
        NOW() - INTERVAL '6 minutes'
      )
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    const hit = found.find((t) => t.title === "wd-fast-codex-image-artifact-blocker");
    expect(hit).toBeDefined();
    expect(hit?.reason).toBe("fast_terminal_failure");
    expect(hit?.blockedSinceMs).toBeLessThan(240 * 60 * 1000);
  });

  it("ignores diagnostic task_logs rows when classifying fast terminal blocked tasks", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (
        ${bizId}, 'watchdog-test-role', 'owner', 'wd-diagnostic-only-blocker', 'Brief', 'blocked',
        'Waiting on owner decision',
        NOW() - INTERVAL '6 minutes'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO task_logs (task_id, type, chunk)
      VALUES (${task.id}, 'diagnostic', ${JSON.stringify({
        kind: "codex_empty_output",
        schemaVersion: 1,
        codexEmptyOutput: true,
        rolloutSignaturePresent: true,
        exitCode: 1,
        modelSlug: "openai-codex/gpt-5.5",
        cwd: "/workspace/hivewrightv2",
        stderrTail: "failed to record rollout items",
        truncated: false,
      })})
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);

    expect(found.some((t) => t.title === "wd-diagnostic-only-blocker")).toBe(false);
  });

  it("still promotes blocked Codex exit-code failures after diagnostics are present", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (
        ${bizId}, 'watchdog-test-role', 'owner', 'wd-codex-exit-with-diagnostic', 'Brief', 'blocked',
        'Codex exited code 1: codex reported error',
        NOW() - INTERVAL '6 minutes'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO task_logs (task_id, type, chunk)
      VALUES (${task.id}, 'diagnostic', ${JSON.stringify({
        kind: "codex_empty_output",
        schemaVersion: 1,
        codexEmptyOutput: true,
        rolloutSignaturePresent: true,
        exitCode: 1,
        modelSlug: "openai-codex/gpt-5.5",
        cwd: "/workspace/hivewrightv2",
        stderrTail: "failed to record rollout items",
        truncated: false,
      })})
    `;

    const found = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000, 5 * 60 * 1000);
    const hit = found.find((t) => t.title === "wd-codex-exit-with-diagnostic");

    expect(hit).toBeDefined();
    expect(hit?.reason).toBe("fast_terminal_failure");
  });

  it("returns empty when ageMs <= 0", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, updated_at)
      VALUES (${bizId}, 'dev-agent', 'owner', 'wd-disabled', 'Brief', 'blocked', NOW() - INTERVAL '6 hours')
    `;

    const found = await findStuckBlockedTasks(sql, 0);
    expect(found).toEqual([]);
  });
});

describe("recoverDiskPressureBlockedTasks", () => {
  it("requeues disk-pressure blocked tasks after space recovers without consuming retries", async () => {
    const [task] = await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status,
        dispatcher_pid, started_at, last_heartbeat, retry_count, failure_reason, updated_at
      )
      VALUES (
        ${bizId}, 'watchdog-test-role', 'owner', 'wd-recover-disk-pressure', 'Brief', 'blocked',
        515151, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', 2,
        'disk_pressure_hard_stop: free=20 total=100 ratio=0.0200 hard_bytes=25 hard_ratio=0.08 warning_bytes=50 warning_ratio=0.15',
        NOW() - INTERVAL '10 minutes'
      )
      RETURNING id
    `;

    const recovered = await recoverDiskPressureBlockedTasks(sql);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].title).toBe("wd-recover-disk-pressure");

    const [updated] = await sql`
      SELECT status, retry_count, dispatcher_pid, started_at, last_heartbeat, failure_reason
      FROM tasks
      WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("pending");
    expect(updated.retry_count).toBe(2);
    expect(updated.dispatcher_pid).toBeNull();
    expect(updated.started_at).toBeNull();
    expect(updated.last_heartbeat).toBeNull();
    expect(updated.failure_reason).toBeNull();
  });
});
