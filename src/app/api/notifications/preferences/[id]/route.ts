import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canMutateHive } from "@/auth/users";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const { id } = await params;

    const [preference] = await sql<{ hive_id: string }[]>`
      SELECT hive_id FROM notification_preferences WHERE id = ${id}
    `;
    if (!preference) {
      return jsonError("Notification preference not found", 404);
    }
    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, preference.hive_id);
      if (!canMutate) return jsonError("Forbidden: caller cannot manage this hive", 403);
    }

    const rows = await sql`
      DELETE FROM notification_preferences
      WHERE id = ${id}
      RETURNING id
    `;

    return jsonOk({ deleted: rows.length > 0 });
  } catch {
    return jsonError("Failed to delete notification preference", 500);
  }
}
