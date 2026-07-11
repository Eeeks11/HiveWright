import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canMutateHive } from "@/auth/users";
import { runDeliberation } from "@/board/deliberate";

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json();
    const { hiveId, question, hiveContext } = body as {
      hiveId?: string;
      question?: string;
      hiveContext?: string;
    };
    if (!hiveId || !question) {
      return jsonError("hiveId and question are required", 400);
    }
    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, hiveId);
      if (!canMutate) return jsonError("Forbidden: hive mutation access required", 403);
    }
    const result = await runDeliberation(sql, { hiveId, question, hiveContext });
    return jsonOk(result);
  } catch (err) {
    console.error("[api/board/deliberate]", err);
    return jsonError(
      err instanceof Error ? err.message : "Deliberation failed",
      500,
    );
  }
}
