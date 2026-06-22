import { canAccessHive } from "@/auth/users";
import { collectSetupRuntimeReadiness, listActiveSetupRuntimeSources } from "@/setup-readiness/runtime";
import { requireApiAuth, requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

export async function GET(request?: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const hiveId = request ? parseSearchParams(request.url).get("hiveId") : null;
  if (!hiveId) return jsonOk(await collectSetupRuntimeReadiness());

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  const runtimeSources = await listActiveSetupRuntimeSources(sql, { hiveId });
  return jsonOk(await collectSetupRuntimeReadiness({ runtimeSources }));
}
