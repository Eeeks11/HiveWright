import { requireResourceOwnedByHive, requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { getDeliverable, toDeliverableSummary } from "@/deliverables/queries";
import { requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;

    const { id } = await params;
    const target = await requireStrictHiveTarget(sql, authz.user, { kind: "query", request });
    if (!target.ok) return target.response;
    const deliverable = await getDeliverable(sql, id);
    const ownership = requireResourceOwnedByHive(deliverable?.hiveId, target.hiveId, { resourceName: "Deliverable" });
    if (!ownership.ok) return ownership.response;
    if (!deliverable) return jsonError("Not found", 404);

    return jsonOk(toDeliverableSummary(deliverable));
  } catch {
    return jsonError("Internal server error", 500);
  }
}
