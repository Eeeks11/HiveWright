import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { mirrorOwnerDecisionCommentToGoalComment } from "@/decisions/owner-comment-wake";

type MessageRow = {
  id: string;
  decision_id: string;
  sender: string;
  content: string;
  created_at: Date;
};

function mapRow(r: MessageRow) {
  return {
    id: r.id,
    decisionId: r.decision_id,
    sender: r.sender,
    content: r.content,
    createdAt: r.created_at,
  };
}

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

    const rows = await sql`
      SELECT id, decision_id, sender, content, created_at
      FROM decision_messages
      WHERE decision_id = ${id}
      ORDER BY created_at ASC
    `;

    return jsonOk((rows as unknown as MessageRow[]).map(mapRow));
  } catch {
    return jsonError("Failed to fetch decision messages", 500);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const { id } = await params;
    const body = await request.json();
    const target = await requireStrictHiveTarget(
      sql,
      user,
      { kind: "body", body: body as Record<string, unknown> },
      { mode: "mutate" },
    );
    if (!target.ok) return target.response;
    const { content, sender } = body as { content?: string; sender?: string };

    if (!content) {
      return jsonError("Missing required field: content", 400);
    }

    const [decision] = await sql<{ hive_id: string }[]>`
      SELECT hive_id FROM decisions WHERE id = ${id} AND hive_id = ${target.hiveId}::uuid
    `;
    if (!decision) return jsonError("Decision not found", 404);

    const senderValue = user.isSystemOwner ? sender || "owner" : "system";

    const rows = await sql`
      INSERT INTO decision_messages (decision_id, sender, content)
      VALUES (${id}, ${senderValue}, ${content})
      RETURNING id, decision_id, sender, content, created_at
    `;
    if (senderValue === "owner") {
      await mirrorOwnerDecisionCommentToGoalComment(sql, rows[0].id as string);
    }

    return jsonOk(mapRow(rows[0] as unknown as MessageRow), 201);
  } catch {
    return jsonError("Failed to create decision message", 500);
  }
}
