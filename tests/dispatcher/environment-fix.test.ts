import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_AUDIT_EVENTS } from "@/audit/agent-events";
import {
  buildFastTerminalEnvironmentFixBrief,
  buildEnvironmentFixTaskTitle,
  createEnvironmentFixTask,
  extractEnvironmentFixParentTaskId,
  isEnvironmentFixTaskTitle,
  resumeBlockedParentAfterEnvironmentFix,
  resumeBlockedParentsAwaitingEnvironmentFixHandoff,
} from "@/dispatcher/environment-fix";
import { blockTask } from "@/dispatcher/task-claimer";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type, active)
    VALUES
      ('dev-agent', 'Dev Agent', 'executor', 'codex', true),
      ('doctor', 'Doctor', 'executor', 'codex', true),
      ('infrastructure-agent', 'Infrastructure Agent', 'executor', 'codex', true)
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        type = EXCLUDED.type,
        adapter_type = EXCLUDED.adapter_type,
        active = EXCLUDED.active
  `;

  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('env-fix-test-hive', 'Environment Fix Test Hive', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
});

describe("environment-fix helpers", () => {
  it("extracts the parent task id from linked or legacy repair tasks", () => {
    const parentTaskId = "00000000-0000-4000-8000-000000000001";

    expect(extractEnvironmentFixParentTaskId({
      assignedTo: "doctor",
      title: buildEnvironmentFixTaskTitle(parentTaskId),
      parentTaskId,
    })).toBe(parentTaskId);

    expect(extractEnvironmentFixParentTaskId({
      assignedTo: "doctor",
      title: buildEnvironmentFixTaskTitle(parentTaskId),
      parentTaskId: null,
    })).toBe(parentTaskId);

    expect(extractEnvironmentFixParentTaskId({
      assignedTo: "doctor",
      title: "[Doctor] Diagnose: something else",
      parentTaskId,
    })).toBeNull();
  });

  it("recognizes retry-wrapped environment-fix task titles", () => {
    const parentTaskId = "00000000-0000-4000-8000-000000000002";
    const retryTitle = `[Doctor retry: auto] ${buildEnvironmentFixTaskTitle(parentTaskId)}`;

    expect(isEnvironmentFixTaskTitle(retryTitle)).toBe(true);
    expect(extractEnvironmentFixParentTaskId({
      assignedTo: "doctor",
      title: retryTitle,
      parentTaskId,
    })).toBe(parentTaskId);
    expect(extractEnvironmentFixParentTaskId({
      assignedTo: "doctor",
      title: retryTitle,
      parentTaskId: null,
    })).toBe(parentTaskId);
  });

  it("extracts the parent task id for non-doctor environment remediation tasks", () => {
    const parentTaskId = "00000000-0000-4000-8000-000000000003";

    expect(extractEnvironmentFixParentTaskId({
      assignedTo: "infrastructure-agent",
      title: buildEnvironmentFixTaskTitle(parentTaskId),
      parentTaskId,
    })).toBe(parentTaskId);
  });

  it("creates an infrastructure-agent remediation task by default and reuses open duplicates", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'env-fix-direct-create', 'Brief', 'failed')
      RETURNING id
    `;

    const created = await createEnvironmentFixTask(sql, {
      parentTaskId: parent.id as string,
      brief: buildFastTerminalEnvironmentFixBrief("Pre-flight failed: Missing required credential"),
      createdBy: "dispatcher",
    });
    const reused = await createEnvironmentFixTask(sql, {
      parentTaskId: parent.id as string,
      brief: "different brief should not matter while child is still open",
      createdBy: "dispatcher",
    });

    expect(created?.assignedTo).toBe("infrastructure-agent");
    expect(created?.title).toBe(buildEnvironmentFixTaskTitle(parent.id as string));
    expect(created?.id).toBe(reused?.id);

    const tasks = await sql`
      SELECT assigned_to, created_by, title, brief
      FROM tasks
      WHERE parent_task_id = ${parent.id}
    `;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_to).toBe("infrastructure-agent");
    expect(tasks[0].created_by).toBe("dispatcher");
    expect(tasks[0].brief).toContain("child-process resolution");
  });

  it("falls back to doctor when the preferred remediation role is inactive", async () => {
    await sql`
      UPDATE role_templates
      SET active = false
      WHERE slug = 'infrastructure-agent'
    `;
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'env-fix-fallback-create', 'Brief', 'failed')
      RETURNING id
    `;

    const created = await createEnvironmentFixTask(sql, {
      parentTaskId: parent.id as string,
      brief: "repair runtime path",
      createdBy: "doctor",
    });

    expect(created?.assignedTo).toBe("doctor");
  });

  it("resumes a blocked parent after a linked environment-fix task completes", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'env-fix-parent', 'Brief', 'blocked', 'Pre-flight failed: Missing required credential')
      RETURNING id
    `;

    const result = await resumeBlockedParentAfterEnvironmentFix(sql, {
      id: "11111111-1111-4111-8111-111111111111",
      assignedTo: "doctor",
      title: buildEnvironmentFixTaskTitle(parent.id as string),
      parentTaskId: parent.id as string,
    });

    expect(result).toEqual({ parentTaskId: parent.id, resumed: true });

    const [updatedParent] = await sql`
      SELECT status, failure_reason
      FROM tasks
      WHERE id = ${parent.id}
    `;
    expect(updatedParent.status).toBe("pending");
    expect(updatedParent.failure_reason).toBeNull();
  });

  it("resumes a blocked parent for legacy standalone environment-fix tasks too", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'legacy-env-fix-parent', 'Brief', 'blocked', 'Codex exited code 1: codex reported error')
      RETURNING id
    `;

    const result = await resumeBlockedParentAfterEnvironmentFix(sql, {
      id: "22222222-2222-4222-8222-222222222222",
      assignedTo: "doctor",
      title: buildEnvironmentFixTaskTitle(parent.id as string),
      parentTaskId: null,
    });

    expect(result).toEqual({ parentTaskId: parent.id, resumed: true });
  });

  it("resumes a blocked parent after a non-doctor environment remediation task completes", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'infra-env-fix-parent', 'Brief', 'blocked', 'Pre-flight failed: Missing required credential')
      RETURNING id
    `;

    const result = await resumeBlockedParentAfterEnvironmentFix(sql, {
      id: "33333333-3333-4333-8333-333333333333",
      assignedTo: "infrastructure-agent",
      title: buildEnvironmentFixTaskTitle(parent.id as string),
      parentTaskId: parent.id as string,
    });

    expect(result).toEqual({ parentTaskId: parent.id, resumed: true });
  });

  it("reconciles blocked parents when a repair task already completed", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'handoff-parent', 'Brief', 'blocked', 'Pre-flight failed: Missing required credential', NOW() - INTERVAL '5 minutes')
      RETURNING id
    `;
    const [repair] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${hiveId},
        'doctor',
        'doctor',
        ${buildEnvironmentFixTaskTitle(parent.id as string)},
        'repair runtime path',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '1 minute'
      )
      RETURNING id
    `;

    const resumed = await resumeBlockedParentsAwaitingEnvironmentFixHandoff(sql);

    expect(resumed).toEqual([{ parentTaskId: parent.id, repairTaskId: repair.id }]);

    const [updatedParent] = await sql`
      SELECT status, failure_reason
      FROM tasks
      WHERE id = ${parent.id}
    `;
    expect(updatedParent.status).toBe("pending");
    expect(updatedParent.failure_reason).toBeNull();
  });

  it("reconciles blocked parents when a retried repair task already completed", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'handoff-parent-retry', 'Brief', 'blocked', 'Spawn error: runtime missing', NOW() - INTERVAL '5 minutes')
      RETURNING id
    `;
    const [repair] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at, adapter_override, model_override)
      VALUES (
        ${hiveId},
        'doctor',
        'dispatcher',
        ${`[Doctor retry: auto] ${buildEnvironmentFixTaskTitle(parent.id as string)}`},
        'repair runtime path',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '1 minute',
        'auto',
        'auto'
      )
      RETURNING id
    `;

    const resumed = await resumeBlockedParentsAwaitingEnvironmentFixHandoff(sql);

    expect(resumed).toEqual([{ parentTaskId: parent.id, repairTaskId: repair.id }]);

    const [updatedParent] = await sql`
      SELECT status, failure_reason
      FROM tasks
      WHERE id = ${parent.id}
    `;
    expect(updatedParent.status).toBe("pending");
    expect(updatedParent.failure_reason).toBeNull();
  });

  it("reconciles blocked parents when a non-doctor environment remediation task already completed", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'handoff-parent-infra', 'Brief', 'blocked', 'Spawn error: runtime missing', NOW() - INTERVAL '5 minutes')
      RETURNING id
    `;
    const [repair] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${hiveId},
        'infrastructure-agent',
        'goal-supervisor',
        ${buildEnvironmentFixTaskTitle(parent.id as string)},
        'repair runtime path',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '1 minute'
      )
      RETURNING id
    `;

    const resumed = await resumeBlockedParentsAwaitingEnvironmentFixHandoff(sql);

    expect(resumed).toEqual([{ parentTaskId: parent.id, repairTaskId: repair.id }]);
  });

  it("reconciles blocked parents from the last blocked transition even if parent updated_at drifted later", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason, updated_at)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'handoff-parent-anchor', 'Brief', 'blocked', 'Pre-flight failed: Missing required credential', NOW() - INTERVAL '1 minute')
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
        ${hiveId},
        ${parent.id},
        'task',
        ${parent.id},
        'success',
        ${sql.json({
          taskId: parent.id,
          previousStatus: "failed",
          nextStatus: "blocked",
          source: "test.environment-fix",
        })},
        NOW() - INTERVAL '6 minutes'
      )
    `;
    const [repair] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${hiveId},
        'infrastructure-agent',
        'goal-supervisor',
        ${buildEnvironmentFixTaskTitle(parent.id as string)},
        'repair runtime path',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '4 minutes'
      )
      RETURNING id
    `;

    const resumed = await resumeBlockedParentsAwaitingEnvironmentFixHandoff(sql);

    expect(resumed).toEqual([{ parentTaskId: parent.id, repairTaskId: repair.id }]);
  });

  it("reconciles dispatcher-blocked parents when updated_at drifts after a successful remediation child", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${hiveId}, 'dev-agent', 'owner', 'handoff-parent-dispatcher-block', 'Brief', 'active')
      RETURNING id
    `;

    await blockTask(sql, parent.id as string, "Pre-flight failed: Missing required credential");
    await sql`
      UPDATE agent_audit_events
      SET created_at = NOW() - INTERVAL '6 minutes'
      WHERE task_id = ${parent.id}
        AND event_type = ${AGENT_AUDIT_EVENTS.taskLifecycleTransition}
        AND COALESCE(metadata->>'nextStatus', '') = 'blocked'
    `;
    const [repair] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id, updated_at)
      VALUES (
        ${hiveId},
        'infrastructure-agent',
        'dispatcher',
        ${buildEnvironmentFixTaskTitle(parent.id as string)},
        'repair runtime path',
        'completed',
        ${parent.id},
        NOW() - INTERVAL '4 minutes'
      )
      RETURNING id
    `;
    await sql`
      UPDATE tasks
      SET updated_at = NOW() - INTERVAL '1 minute'
      WHERE id = ${parent.id}
    `;

    const resumed = await resumeBlockedParentsAwaitingEnvironmentFixHandoff(sql);

    expect(resumed).toEqual([{ parentTaskId: parent.id, repairTaskId: repair.id }]);
  });
});
