import { canAccessHive } from "@/auth/users";
import { buildRuntimeDriftOperatorReport } from "@/operations/runtime-drift-report";
import { jsonError, jsonOk } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";

const HIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  }
  return { hiveId, taskId: url.searchParams.get("taskId") };
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
