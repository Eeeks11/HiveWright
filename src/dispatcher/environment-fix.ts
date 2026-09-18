import type { Sql } from "postgres";
import { AGENT_AUDIT_EVENTS } from "@/audit/agent-events";
import { recordTaskLifecycleTransitionBestEffort } from "@/audit/task-lifecycle";
import { writeTaskLog } from "./task-log-writer";
import { inheritTaskWorkspaceFromParent } from "./worktree-manager";

export const ENVIRONMENT_FIX_TASK_TITLE_PREFIX = "Fix environment for: ";
export const ENVIRONMENT_FIX_RETRY_TITLE_PREFIX = "[Doctor retry:";
export const DEFAULT_ENVIRONMENT_FIX_ASSIGNEE = "infrastructure-agent";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EnvironmentFixTaskRef = {
  assignedTo: string;
  title: string;
  parentTaskId: string | null;
};

type EnvironmentFixCompletionTask = EnvironmentFixTaskRef & {
  id: string;
};

type PendingEnvironmentFixHandoffTask = EnvironmentFixCompletionTask & {
  status: string;
};

type EnvironmentFixTaskRow = EnvironmentFixCompletionTask & {
  status: string;
};

type CreateEnvironmentFixTaskInput = {
  parentTaskId: string;
  brief: string;
  createdBy: string;
  preferredAssignedTo?: string | null;
};

export function buildEnvironmentFixTaskTitle(parentTaskId: string): string {
  return `${ENVIRONMENT_FIX_TASK_TITLE_PREFIX}${parentTaskId}`;
}

export function buildFastTerminalEnvironmentFixBrief(failureReason: string): string {
  return [
    "Inspect and repair the fast terminal adapter/preflight path for the blocked parent task.",
    "",
    "Required checks:",
    "1. Validate the failing preflight, runtime-health, or child-process resolution path.",
    "2. Repair the adapter supervision or environment configuration so the child resolves cleanly.",
    "3. Confirm watchdog completion handoff resumes the blocked parent instead of orphaning a successful investigator run.",
    "",
    `Blocked parent failure reason: ${failureReason.trim()}`,
  ].join("\n");
}

function normalizeEnvironmentFixTaskTitle(title: string): string {
  if (!title.startsWith(ENVIRONMENT_FIX_RETRY_TITLE_PREFIX)) return title;
  const closingBracket = title.indexOf("]");
  if (closingBracket < 0) return title;
  return title.slice(closingBracket + 1).trimStart();
}

export function isEnvironmentFixTaskTitle(title: string): boolean {
  return normalizeEnvironmentFixTaskTitle(title).startsWith(ENVIRONMENT_FIX_TASK_TITLE_PREFIX);
}

export function extractEnvironmentFixParentTaskId(
  task: EnvironmentFixTaskRef,
): string | null {
  const normalizedTitle = normalizeEnvironmentFixTaskTitle(task.title);
  if (!normalizedTitle.startsWith(ENVIRONMENT_FIX_TASK_TITLE_PREFIX)) return null;

  const linkedParentId = task.parentTaskId?.trim();
  if (linkedParentId && UUID_RE.test(linkedParentId)) return linkedParentId;

  const titleParentId = normalizedTitle.slice(ENVIRONMENT_FIX_TASK_TITLE_PREFIX.length).trim();
  return UUID_RE.test(titleParentId) ? titleParentId : null;
}

export function isEnvironmentFixTask(task: EnvironmentFixTaskRef): boolean {
  return extractEnvironmentFixParentTaskId(task) !== null;
}

async function resolveEnvironmentFixAssignee(
  sql: Sql,
  preferredAssignedTo: string | null | undefined,
): Promise<string> {
  const preferred = preferredAssignedTo?.trim() || DEFAULT_ENVIRONMENT_FIX_ASSIGNEE;
  const [preferredRole] = await sql<{ slug: string }[]>`
    SELECT slug
    FROM role_templates
    WHERE slug = ${preferred}
      AND active = true
    LIMIT 1
  `;
  if (preferredRole?.slug) return preferredRole.slug;

  return "doctor";
}

export async function findExistingOpenEnvironmentFixTask(
  sql: Sql,
  parentTaskId: string,
): Promise<EnvironmentFixTaskRow | null> {
  const [task] = await sql<EnvironmentFixTaskRow[]>`
    SELECT
      id,
      assigned_to AS "assignedTo",
      title,
      parent_task_id AS "parentTaskId",
      status
    FROM tasks
    WHERE (
        parent_task_id = ${parentTaskId}
        OR (
          parent_task_id IS NULL
          AND (
            title = ${buildEnvironmentFixTaskTitle(parentTaskId)}
            OR title LIKE ${`${ENVIRONMENT_FIX_RETRY_TITLE_PREFIX}%] ${buildEnvironmentFixTaskTitle(parentTaskId)}`}
          )
        )
      )
      AND (
        title LIKE ${`${ENVIRONMENT_FIX_TASK_TITLE_PREFIX}%`}
        OR title LIKE ${`${ENVIRONMENT_FIX_RETRY_TITLE_PREFIX}%] ${ENVIRONMENT_FIX_TASK_TITLE_PREFIX}%`}
      )
      AND status IN ('pending', 'active', 'claimed', 'running', 'in_review')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return task ?? null;
}

export async function createEnvironmentFixTask(
  sql: Sql,
  input: CreateEnvironmentFixTaskInput,
): Promise<EnvironmentFixTaskRow | null> {
  const existingTask = await findExistingOpenEnvironmentFixTask(sql, input.parentTaskId);
  if (existingTask) return existingTask;

  const [parent] = await sql<{
    hive_id: string;
    project_id: string | null;
  }[]>`
    SELECT hive_id, project_id
    FROM tasks
    WHERE id = ${input.parentTaskId}
    LIMIT 1
  `;
  if (!parent) return null;

  const assignedTo = await resolveEnvironmentFixAssignee(sql, input.preferredAssignedTo);
  const [task] = await sql<EnvironmentFixTaskRow[]>`
    INSERT INTO tasks (
      hive_id,
      assigned_to,
      created_by,
      title,
      brief,
      parent_task_id,
      project_id
    )
    VALUES (
      ${parent.hive_id},
      ${assignedTo},
      ${input.createdBy},
      ${buildEnvironmentFixTaskTitle(input.parentTaskId)},
      ${input.brief},
      ${input.parentTaskId},
      ${parent.project_id}
    )
    RETURNING
      id,
      assigned_to AS "assignedTo",
      title,
      parent_task_id AS "parentTaskId",
      status
  `;
  await inheritTaskWorkspaceFromParent(sql, input.parentTaskId, task.id);
  return task;
}

export async function resumeBlockedParentAfterEnvironmentFix(
  sql: Sql,
  task: EnvironmentFixCompletionTask,
): Promise<{ parentTaskId: string | null; resumed: boolean }> {
  const parentTaskId = extractEnvironmentFixParentTaskId(task);
  if (!parentTaskId) return { parentTaskId: null, resumed: false };

  const [parent] = await sql<{
    hive_id: string;
    goal_id: string | null;
    status: string;
  }[]>`
    SELECT hive_id, goal_id, status
    FROM tasks
    WHERE id = ${parentTaskId}
    LIMIT 1
  `;
  if (!parent) return { parentTaskId, resumed: false };

  const [updated] = await sql<{ status: string }[]>`
    UPDATE tasks
    SET status = 'pending',
        failure_reason = NULL,
        retry_after = NULL,
        updated_at = NOW()
    WHERE id = ${parentTaskId}
      AND status = 'blocked'
    RETURNING status
  `;
  if (!updated) return { parentTaskId, resumed: false };

  await recordTaskLifecycleTransitionBestEffort(sql, {
    taskId: parentTaskId,
    hiveId: parent.hive_id,
    goalId: parent.goal_id,
    previousStatus: parent.status,
    nextStatus: updated.status,
    source: "dispatcher.environmentFixCompletion",
    reason: `Environment fix task ${task.id} completed and handed the blocked task back for retry.`,
  });
  await writeTaskLog(sql, {
    taskId: parentTaskId,
    goalId: parent.goal_id ?? undefined,
    chunk: `[environment-fix] Repair task ${task.id} completed; resuming original task.`,
    type: "status",
  }).catch(() => {});

  return { parentTaskId, resumed: true };
}

export async function resumeBlockedParentsAwaitingEnvironmentFixHandoff(
  sql: Sql,
): Promise<Array<{ parentTaskId: string; repairTaskId: string }>> {
  const rows = await sql<PendingEnvironmentFixHandoffTask[]>`
    SELECT DISTINCT ON (parent.id)
      repair.id,
      repair.assigned_to AS "assignedTo",
      repair.title,
      repair.parent_task_id AS "parentTaskId",
      repair.status
    FROM tasks parent
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        (
          SELECT MAX(a.created_at)
          FROM agent_audit_events a
          WHERE a.task_id = parent.id
            AND a.event_type = ${AGENT_AUDIT_EVENTS.taskLifecycleTransition}
            AND COALESCE(a.metadata->>'nextStatus', '') = 'blocked'
        ),
        parent.updated_at
      ) AS blocked_since_at
    ) block_anchor
    JOIN tasks repair
      ON (
        repair.parent_task_id = parent.id
        OR (
          repair.parent_task_id IS NULL
          AND (
            repair.title = ${ENVIRONMENT_FIX_TASK_TITLE_PREFIX} || parent.id::text
            OR repair.title LIKE ${`${ENVIRONMENT_FIX_RETRY_TITLE_PREFIX}%] ${ENVIRONMENT_FIX_TASK_TITLE_PREFIX}`} || parent.id::text
          )
        )
      )
    WHERE parent.status = 'blocked'
      AND repair.status = 'completed'
      AND (
        repair.title LIKE ${`${ENVIRONMENT_FIX_TASK_TITLE_PREFIX}%`}
        OR repair.title LIKE ${`${ENVIRONMENT_FIX_RETRY_TITLE_PREFIX}%] ${ENVIRONMENT_FIX_TASK_TITLE_PREFIX}%`}
      )
      AND repair.updated_at >= block_anchor.blocked_since_at
    ORDER BY parent.id, repair.updated_at DESC, repair.created_at DESC
  `;

  const resumed: Array<{ parentTaskId: string; repairTaskId: string }> = [];
  for (const row of rows) {
    const handoff = await resumeBlockedParentAfterEnvironmentFix(sql, row);
    if (handoff.resumed && handoff.parentTaskId) {
      resumed.push({ parentTaskId: handoff.parentTaskId, repairTaskId: row.id });
    }
  }

  return resumed;
}
