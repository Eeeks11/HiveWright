import { canAccessHive } from "@/auth/users";
import { getDeliverable, toDeliverableSummary } from "@/deliverables/queries";
import { requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;

    const { id } = await params;
    const deliverable = await getDeliverable(sql, id);
    if (!deliverable) return jsonError("Not found", 404);

    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, deliverable.hiveId);
      if (!hasAccess) return jsonError("Forbidden", 403);
    }

    return jsonOk(toDeliverableSummary(deliverable));
  } catch {
    return jsonError("Internal server error", 500);
  }
}
