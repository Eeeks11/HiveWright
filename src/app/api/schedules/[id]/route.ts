import { requireResourceOwnedByHive, requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { loadScheduleDetail } from "@/schedules/detail";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!id) return jsonError("id is required", 400);

  try {
    const target = await requireStrictHiveTarget(sql, authz.user, { kind: "query", request });
    if (!target.ok) return target.response;
    const detail = await loadScheduleDetail(sql, id);
    const ownership = requireResourceOwnedByHive(detail?.schedule.hiveId, target.hiveId, { resourceName: "Schedule" });
    if (!ownership.ok) return ownership.response;

    return jsonOk(detail);
  } catch {
    return jsonError("Failed to fetch schedule", 500);
  }
}
