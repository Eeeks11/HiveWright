import type { Sql } from "postgres";

const TERMINAL_GOAL_STATUSES = new Set(["achieved", "failed", "abandoned", "cancelled"]);

export interface GoalProgressSnapshot {
  status: string;
  taskCount: number;
  documentCount: number;
  commentCount: number;
  decisionCount: number;
  latestDocumentUpdate: string | null;
}

export async function claimGoalSupervisorStart(
  sql: Sql,
  goalId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE goals
    SET session_id = ${sessionId}, updated_at = NOW()
    WHERE id = ${goalId}
      AND status = 'active'
      AND session_id IS NULL
    RETURNING id
  `;
  return rows.length === 1;
}

export async function releaseGoalSupervisorStart(
  sql: Sql,
  goalId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await sql`
    UPDATE goals
    SET session_id = NULL, updated_at = NOW()
    WHERE id = ${goalId}
      AND status = 'active'
      AND session_id = ${sessionId}
    RETURNING id
  `;
  return rows.length === 1;
}

export async function captureGoalProgress(
  sql: Sql,
  goalId: string,
): Promise<GoalProgressSnapshot> {
  const [row] = await sql`
    SELECT
      g.status,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.goal_id = g.id) AS task_count,
      (SELECT COUNT(*)::int FROM goal_documents d WHERE d.goal_id = g.id) AS document_count,
      (SELECT COUNT(*)::int FROM goal_comments c WHERE c.goal_id = g.id) AS comment_count,
      (SELECT COUNT(*)::int FROM decisions x WHERE x.goal_id = g.id) AS decision_count,
      (SELECT MAX(d.updated_at)::text FROM goal_documents d WHERE d.goal_id = g.id) AS latest_document_update
    FROM goals g
    WHERE g.id = ${goalId}
  `;
  if (!row) throw new Error(`Goal not found while checking supervisor progress: ${goalId}`);
  return {
    status: row.status as string,
    taskCount: Number(row.task_count),
    documentCount: Number(row.document_count),
    commentCount: Number(row.comment_count),
    decisionCount: Number(row.decision_count),
    latestDocumentUpdate: (row.latest_document_update ?? null) as string | null,
  };
}

function hasProgressed(before: GoalProgressSnapshot, after: GoalProgressSnapshot): boolean {
  return after.taskCount > before.taskCount
    || after.documentCount > before.documentCount
    || after.commentCount > before.commentCount
    || after.decisionCount > before.decisionCount
    || after.latestDocumentUpdate !== before.latestDocumentUpdate;
}

export async function finalizeGoalSupervisorStart(
  sql: Sql,
  goalId: string,
  sessionId: string,
  baseline: GoalProgressSnapshot,
): Promise<{ progressed: boolean; terminal: boolean }> {
  const current = await captureGoalProgress(sql, goalId);
  const terminal = TERMINAL_GOAL_STATUSES.has(current.status);
  const progressed = terminal || hasProgressed(baseline, current);
  if (!progressed) {
    await releaseGoalSupervisorStart(sql, goalId, sessionId);
  }
  return { progressed, terminal };
}
