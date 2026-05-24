import { canAccessHive } from "@/auth/users";
import { getHiveScoreboard } from "@/hives/scoreboard";
import type { NextResponse } from "next/server";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await resolveHiveAccess(params);
  if ("response" in access) return access.response;

  const scoreboard = await getHiveScoreboard(sql, access.hiveId);
  if (!scoreboard) return jsonError("hive not found", 404);

  return jsonOk(scoreboard);
}

type HiveAccess =
  | { response: NextResponse }
  | { hiveId: string };

async function resolveHiveAccess(paramsPromise: Promise<{ id: string }>): Promise<HiveAccess> {
  const authz = await requireApiUser();
  if ("response" in authz) return { response: authz.response };

  const { id } = await paramsPromise;
  if (!id) return { response: jsonError("hive id is required", 400) };

  const [hive] = await sql<{ id: string }[]>`
    SELECT id FROM hives WHERE id = ${id}
  `;
  if (!hive) return { response: jsonError("hive not found", 404) };

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) {
      return { response: jsonError("Forbidden: hive access required", 403) };
    }
  }

  return { hiveId: hive.id };
}
