import { canAccessHive } from "@/auth/users";
import { listDeliverables } from "@/deliverables/queries";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";

export async function GET(request: Request) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;

    const { searchParams } = new URL(request.url);
    const hiveId = searchParams.get("hiveId");
    const taskId = searchParams.get("taskId");
    const goalId = searchParams.get("goalId");

    if (!authz.user.isSystemOwner) {
      if (!hiveId) return jsonError("hiveId is required", 400);
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden", 403);
    }

    const deliverables = await listDeliverables(sql, { hiveId, taskId, goalId });
    return jsonOk(deliverables);
  } catch {
    return jsonError("Internal server error", 500);
  }
}
