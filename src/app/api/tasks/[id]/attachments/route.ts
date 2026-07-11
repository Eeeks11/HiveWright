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

    // 404 if the task doesn't exist — distinguishes "no such task" from
    // "task exists but has no attachments".
    const [task] = await sql<{ id: string; hive_id: string; goal_id: string | null }[]>`
      SELECT id, hive_id, goal_id FROM tasks WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
    `;
    if (!task) {
      return jsonError("Task not found", 404);
    }
    // Own attachments + attachments inherited from parent goal (if any).
    // Tagged with `source` so the UI can render origin if it cares.
    const rows = await sql`
      SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.uploaded_at,
             CASE WHEN a.task_id IS NOT NULL THEN 'task' ELSE 'goal' END AS source
      FROM task_attachments a
      WHERE a.task_id = ${id}
         OR a.goal_id = ${task.goal_id}
      ORDER BY a.uploaded_at ASC
    `;
    return jsonOk(
      rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mime_type,
        // safe: file size is capped at 25 MB, well within Number.MAX_SAFE_INTEGER
        sizeBytes: Number(r.size_bytes),
        uploadedAt: r.uploaded_at,
        source: r.source,
      })),
    );
  } catch {
    return jsonError("Failed to fetch attachments", 500);
  }
}
