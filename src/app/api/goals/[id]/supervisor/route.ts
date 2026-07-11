import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { loadSupervisorActivity } from "@/goals/supervisor-rollout";

/**
 * GET /api/goals/:id/supervisor
 *
 * Returns the goal supervisor's recent thoughts, reasoning, and tool calls
 * by parsing the codex rollout file linked to the goal's session_id (the
 * supervisor workspace path on disk). Read-only — does not touch the
 * dispatcher or running supervisor.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return jsonError("id must be a valid UUID", 400);
  }

  const target = await requireStrictHiveTarget(sql, authz.user, { kind: "query", request });
  if (!target.ok) return target.response;
  const [row] = await sql<{ hive_id: string; session_id: string | null; status: string }[]>`
    SELECT hive_id, session_id, status FROM goals WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
  `;
  if (!row) return jsonError("Goal not found", 404);
  if (!row.session_id) {
    return jsonOk({
      threadId: null,
      workspacePath: null,
      rolloutPath: null,
      lastActivityAt: null,
      active: false,
      events: [],
      goalStatus: row.status,
    });
  }

  const activity = await loadSupervisorActivity(row.session_id);
  return jsonOk({ ...activity, goalStatus: row.status });
}
