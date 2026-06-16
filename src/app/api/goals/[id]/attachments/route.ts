import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { user } = authz;
    const { id } = await params;
    const target = await requireStrictHiveTarget(sql, user, { kind: "query", request });
    if (!target.ok) return target.response;

    const [goal] = await sql<{ id: string; hive_id: string }[]>`
      SELECT id, hive_id FROM goals WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
    `;
    if (!goal) {
      return jsonError("Goal not found", 404);
    }

    const rows = await sql`
      SELECT id, filename, mime_type, size_bytes, uploaded_at
      FROM task_attachments
      WHERE goal_id = ${id} AND hive_id = ${target.hiveId}::uuid
      ORDER BY uploaded_at ASC
    `;
    return jsonOk(
      rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mime_type,
        // safe: file size is capped at 25 MB, well within Number.MAX_SAFE_INTEGER
        sizeBytes: Number(r.size_bytes),
        uploadedAt: r.uploaded_at,
      })),
    );
  } catch {
    return jsonError("Failed to fetch attachments", 500);
  }
}
