import { NextResponse } from "next/server";
import { sql } from "@/app/api/_lib/db";
import { requireApiUser } from "@/app/api/_lib/auth";
import { requireStrictHiveTarget } from "@/app/api/_lib/hive-target";
import { listGoalDocuments } from "@/goals/goal-documents";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
    return NextResponse.json({ error: "goal not found" }, { status: 404 });
  }

  const docs = await listGoalDocuments(sql, id);
  return NextResponse.json({ documents: docs });
}
