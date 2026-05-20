import { sql } from "@/app/api/_lib/db";
import { requireSystemOwner } from "@/app/api/_lib/auth";
import { jsonError, jsonOk } from "@/app/api/_lib/responses";
import { getCreationPauseOperatorSnapshot } from "@/operations/creation-pause-control-plane";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  const [hive] = await sql`SELECT 1 FROM hives WHERE id = ${id} LIMIT 1`;
  if (!hive) return jsonError("hive not found", 404);

  return jsonOk(await getCreationPauseOperatorSnapshot(sql, id));
}
