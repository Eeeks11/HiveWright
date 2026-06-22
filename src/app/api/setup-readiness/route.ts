import { canAccessHive } from "@/auth/users";
import { collectSetupRuntimeReadiness, listActiveSetupRuntimeSources } from "@/setup-readiness/runtime";
import { getInternalTaskScope, requireApiAuth, requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

export async function GET(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const hiveId = parseSearchParams(request.url).get("hiveId");
  if (!hiveId) return jsonOk(await collectSetupRuntimeReadiness());

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const scoped = await getInternalTaskScope();
  if (scoped.ok === false) return scoped.response;
  if (scoped.scope && scoped.scope.hiveId !== hiveId) {
    return jsonError("Forbidden: task scope cannot access this hive", 403);
  }

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  const runtimeSources = await listActiveSetupRuntimeSources(sql, { hiveId });
  return jsonOk(await collectSetupRuntimeReadiness({ runtimeSources }));
}
