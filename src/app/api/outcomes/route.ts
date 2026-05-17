import { canAccessHive } from "@/auth/users";
import { listOwnerOutcomes } from "@/outcomes/queries";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  if (!hiveId) {
    return Response.json({ error: "hiveId is required" }, { status: 400 });
  }
  if (!UUID_RE.test(hiveId)) {
    return Response.json({ error: "hiveId must be a valid UUID" }, { status: 400 });
  }

  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, hiveId);
    if (!hasAccess) {
      return Response.json({ error: "Forbidden: caller cannot access this hive" }, { status: 403 });
    }
  }

  const outcomes = await listOwnerOutcomes(sql, { hiveId, limit: 100 });
  return Response.json({ data: outcomes });
}
