import { sql } from "@/app/api/_lib/db";
import { requireApiUser } from "@/app/api/_lib/auth";
import { jsonError, jsonOk } from "@/app/api/_lib/responses";
import { canAccessHive, canMutateHive } from "@/auth/users";
import {
  getHiveMemoryGovernanceSummary,
  setHiveMemoryGovernanceState,
} from "@/memory/governance";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) return jsonError("Forbidden: hive access required", 403);
  }

  return jsonOk(await getHiveMemoryGovernanceSummary(sql, id));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  if (!authz.user.isSystemOwner) {
    const canMutate = await canMutateHive(sql, authz.user.id, id);
    if (!canMutate) return jsonError("Forbidden: caller cannot manage this hive", 403);
  }

  let body: { enabled?: unknown; reason?: unknown };
  try {
    body = await request.json() as { enabled?: unknown; reason?: unknown };
  } catch {
    return jsonError("invalid JSON", 400);
  }

  if (typeof body.enabled !== "boolean") {
    return jsonError("enabled must be a boolean", 400);
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!body.enabled && reason.length === 0) {
    return jsonError("reason is required when disabling hive memory", 400);
  }
  if (reason.length > 500) return jsonError("reason is too long", 400);

  return jsonOk(await setHiveMemoryGovernanceState(sql, {
    hiveId: id,
    enabled: body.enabled,
    reason,
    changedBy: authz.user.email,
  }));
}
