import { canAccessHive } from "@/auth/users";
import { buildAnalystTelemetrySummary } from "@/operations/analyst-telemetry-summary";
import { requireApiUser, getInternalTaskScope } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

const HIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorizeAnalystTelemetrySummary(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const params = parseSearchParams(request.url);
  const hiveId = params.get("hiveId");
  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!HIVE_ID_RE.test(hiveId)) return jsonError("hiveId must be a valid UUID", 400);

  const scoped = await getInternalTaskScope();
  if (scoped.ok === false) return scoped.response;
  if (scoped.scope && scoped.scope.hiveId !== hiveId) {
    return jsonError("Forbidden: task scope cannot access this hive", 403);
  }

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  return { hiveId };
}

export async function GET(request: Request) {
  try {
    const authorized = await authorizeAnalystTelemetrySummary(request);
    if (authorized instanceof Response) return authorized;

    const summary = await buildAnalystTelemetrySummary({
      sql,
      hiveId: authorized.hiveId,
    });
    return jsonOk(summary);
  } catch (err) {
    console.error("[analyst-telemetry GET] failed:", err);
    return jsonError("Failed to build analyst telemetry summary", 500);
  }
}
