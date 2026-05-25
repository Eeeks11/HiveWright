import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canMutateHive } from "@/auth/users";
import { sendNotification } from "../../../../notifications/sender";

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json();
    const { hiveId } = body as { hiveId?: string };

    if (!hiveId) {
      return jsonError("hiveId is required", 400);
    }
    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, hiveId);
      if (!canMutate) return jsonError("Forbidden: caller cannot manage this hive", 403);
    }

    const result = await sendNotification(sql, {
      hiveId,
      title: "Test Notification",
      message: "This is a test notification from HiveWright.",
      priority: "urgent",
      source: "test",
    });

    return jsonOk(result);
  } catch {
    return jsonError("Failed to send test notification", 500);
  }
}
