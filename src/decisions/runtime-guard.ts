import type { Sql } from "postgres";

export async function ensureRuntimeGuardDecision(
  sql: Sql,
  taskId: string,
  reason: string,
) {
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`runtime-guard-decision:${taskId}`}))`;

    const [existing] = await tx`
      SELECT *
      FROM decisions
      WHERE task_id = ${taskId}
        AND kind = 'runtime_guard'
        AND status IN ('ea_review', 'pending')
      ORDER BY created_at ASC
      LIMIT 1
    `;
    if (existing) return existing;

    const [task] = await tx`
      SELECT id, hive_id, goal_id, title, brief, assigned_to
      FROM tasks
      WHERE id = ${taskId}
      FOR UPDATE
    `;
    if (!task) return null;

    const context = [
      `Direct task "${task.title}" was interrupted by the Runtime Loop Guard while the adapter was running.`,
      "",
      "The guard used only structured runtime tool-call events from the adapter stream. It did not infer a hard stop from prose output.",
      "",
      `Task ID: ${task.id}`,
      `Current role: ${task.assigned_to}`,
      "",
      "### Runtime Guard Reason",
      reason,
      "",
      "### Original Brief",
      task.brief,
    ].join("\n");

    await tx`
      UPDATE tasks
      SET status = 'blocked',
          failure_reason = ${`Runtime guard interrupted task. ${reason}`},
          updated_at = NOW()
      WHERE id = ${taskId}
    `;

    const [decision] = await tx`
      INSERT INTO decisions (
        hive_id, goal_id, task_id, title, context, recommendation, options, priority, status, kind
      )
      VALUES (
        ${task.hive_id},
        ${task.goal_id},
        ${task.id},
        ${`Runtime guard interrupted: ${task.title}`},
        ${context},
        ${"Recommended: let the EA inspect whether the task needs a narrower brief, a different role, or owner direction before retrying."},
        ${sql.json({
          kind: "runtime_guard_recovery",
          taskId: task.id,
          options: [
            { label: "Refine the brief and retry", action: "refine_brief_and_retry" },
            { label: "Retry with a different role", action: "retry_with_different_role" },
            { label: "Ask owner for direction", action: "ask_owner" },
          ],
        })},
        'urgent',
        'ea_review',
        'runtime_guard'
      )
      RETURNING *
    `;
    return decision ?? null;
  });
}
