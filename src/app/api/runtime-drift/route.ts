import { canAccessHive, canMutateHive } from "@/auth/users";
import { buildRuntimeDriftOperatorReport } from "@/operations/runtime-drift-report";
import { jsonError, jsonOk } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";

const HIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_ID_RE = HIVE_ID_RE;

type TaskHiveRow = {
  hive_id: string;
};

async function authorizeHiveRequest(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!HIVE_ID_RE.test(hiveId)) return jsonError("hiveId must be a valid UUID", 400);
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    const canManage = await canMutateHive(sql, user.id, hiveId);
    if (!canManage) return jsonError("Forbidden: caller cannot manage this hive", 403);
  }

  const taskId = url.searchParams.get("taskId");
  if (!taskId) return { hiveId, taskId };
  if (!TASK_ID_RE.test(taskId)) return jsonError("taskId must be a valid UUID", 400);

  const taskRows = await sql`
    SELECT hive_id
    FROM tasks
    WHERE id = ${taskId}
  `;
  if (taskRows.length === 0) return jsonError("Task not found", 404);

  const taskHiveId = (taskRows[0] as unknown as TaskHiveRow).hive_id;
  if (taskHiveId !== hiveId) return jsonError("Task not found", 404);

  return { hiveId, taskId };
}

export async function GET(request: Request) {
  try {
    const authorized = await authorizeHiveRequest(request);
    if (authorized instanceof Response) return authorized;
    const report = await buildRuntimeDriftOperatorReport({
      sql,
      hiveId: authorized.hiveId,
      taskId: authorized.taskId,
    });
    return jsonOk(report);
  } catch (err) {
    console.error("[runtime-drift GET] failed:", err);
    return jsonError("Failed to build runtime drift report", 500);
  }
}
