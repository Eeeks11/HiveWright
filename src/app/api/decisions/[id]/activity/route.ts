import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { getDecisionActivity } from "@/decisions/activity";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { jsonError, jsonOk } from "../../../_lib/responses";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const { id } = await params;
    const target = await requireStrictHiveTarget(sql, user, { kind: "query", request });
    if (!target.ok) return target.response;
    const [decision] = await sql<{ hive_id: string }[]>`
      SELECT hive_id FROM decisions WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
    `;
    if (!decision) return jsonError("Decision not found", 404);

    const entries = await getDecisionActivity(sql, id);
    return jsonOk(
      entries.map((entry) => ({
        ...entry,
        timestamp: entry.timestamp,
      })),
    );
  } catch {
    return jsonError("Failed to fetch decision activity", 500);
  }
}
