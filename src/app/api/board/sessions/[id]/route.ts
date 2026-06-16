import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { id } = await ctx.params;
    const target = await requireStrictHiveTarget(sql, authz.user, { kind: "query", request });
    if (!target.ok) return target.response;
    const [session] = await sql`
      SELECT id, hive_id, question, status, recommendation, error_text, created_at, completed_at
      FROM board_sessions WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
    `;
    if (!session) return jsonError("session not found", 404);
    const turns = await sql`
      SELECT member_slug, member_name, content, order_index, created_at
      FROM board_turns WHERE session_id = ${id}
      ORDER BY order_index ASC
    `;
    return jsonOk({ session, turns });
  } catch (err) {
    console.error("[api/board/sessions/:id GET]", err);
    return jsonError("Failed to fetch session", 500);
  }
}
