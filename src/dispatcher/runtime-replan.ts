import type { Sql } from "postgres";
import { inheritTaskWorkspaceFromParent } from "./worktree-manager";

export async function findExistingRuntimeReplanTask(sql: Sql, taskId: string) {
  const [task] = await sql`
    SELECT *
    FROM tasks
    WHERE parent_task_id = ${taskId}
      AND assigned_to = 'goal-supervisor'
      AND created_by = 'dispatcher'
      AND title LIKE '[Replan] Runtime guard interrupted:%'
      AND status IN ('pending', 'active', 'running', 'claimed', 'in_review')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return task ?? null;
}

export async function failTaskWithRuntimeReplan(
  sql: Sql,
  taskId: string,
  reason: string,
) {
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`runtime-replan:${taskId}`}))`;

    await tx`
      UPDATE tasks
      SET status = 'failed',
          failure_reason = ${`Runtime guard interrupted task. ${reason}`},
          updated_at = NOW()
      WHERE id = ${taskId}
    `;

    return await createGoalSupervisorRuntimeReplanTaskInTx(tx as unknown as Sql, taskId, reason);
  });
}

export async function createGoalSupervisorRuntimeReplanTask(
  sql: Sql,
  taskId: string,
  reason: string,
) {
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`runtime-replan:${taskId}`}))`;
    return await createGoalSupervisorRuntimeReplanTaskInTx(tx as unknown as Sql, taskId, reason);
  });
}

async function createGoalSupervisorRuntimeReplanTaskInTx(
  sql: Sql,
  taskId: string,
  reason: string,
) {
  const existing = await findExistingRuntimeReplanTask(sql, taskId);
  if (existing) return existing;

  const [task] = await sql`
    SELECT id, hive_id, goal_id, sprint_number, title, brief, acceptance_criteria, project_id
    FROM tasks
    WHERE id = ${taskId}
    FOR UPDATE
  `;
  if (!task?.goal_id) return null;

  const replanBrief = [
    "## Runtime Loop Guard Re-Planning",
    "",
    "The Runtime Loop Guard interrupted a sprint task while the adapter was running. This was based only on structured runtime tool-call events, not prose output.",
    `Parent Task ID: ${task.id}`,
    `Title: ${task.title}`,
    task.sprint_number ? `Sprint: ${task.sprint_number}` : "",
    "",
    "### Runtime Guard Reason",
    reason,
    "",
    "### Original Brief",
    task.brief,
    "",
    task.acceptance_criteria ? `### Acceptance Criteria\n${task.acceptance_criteria}` : "",
    "",
    "### Your Job",
    "Decompose, rewrite, or replace this task so the goal can continue without repeating the same runtime tool loop.",
    "Do not ask the owner unless the task cannot be safely reframed from the existing goal context.",
  ].filter(Boolean).join("\n");

  const [replanTask] = await sql`
    INSERT INTO tasks (
      hive_id,
      assigned_to,
      created_by,
      title,
      brief,
      goal_id,
      sprint_number,
      parent_task_id,
      priority,
      qa_required,
      project_id
    )
    SELECT
      hive_id,
      'goal-supervisor',
      'dispatcher',
      ${`[Replan] Runtime guard interrupted: ${task.title}`},
      ${replanBrief},
      goal_id,
      sprint_number,
      ${taskId},
      1,
      false,
      ${task.project_id}
    FROM tasks
    WHERE id = ${taskId}
    RETURNING *
  `;
  if (replanTask?.id) {
    await inheritTaskWorkspaceFromParent(sql, taskId, replanTask.id as string);
  }
  return replanTask ?? null;
}
