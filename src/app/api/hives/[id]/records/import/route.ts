import { canAccessHive } from "@/auth/users";
import {
  importHiveRecordsFromCsv,
  MAX_CSV_IMPORT_BYTES,
} from "@/hives/records";
import { type HiveKind, normalizeHiveKind } from "@/hives/kind";
import type { NextResponse } from "next/server";
import { type AuthenticatedApiUser, requireApiUser } from "../../../../_lib/auth";
import { sql } from "../../../../_lib/db";
import { jsonError, jsonOk } from "../../../../_lib/responses";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const access = await resolveHiveAccess(params);
  if ("response" in access) return access.response;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("multipart form data is required", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return jsonError("CSV file is required", 400);
  }
  if (file.size > MAX_CSV_IMPORT_BYTES) {
    return jsonError(`CSV payload is too large; maximum is ${MAX_CSV_IMPORT_BYTES} bytes`, 413);
  }

  try {
    const result = await importHiveRecordsFromCsv(sql, {
      hiveId: access.hive.id,
      hiveKind: access.hive.kind,
      csvText: await file.text(),
      filename: file.name,
    });
    return jsonOk(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid CSV import";
    const status = /too large|row limit/i.test(message) ? 413 : 400;
    return jsonError(message, status);
  }
}

type HiveAccess =
  | { response: NextResponse }
  | { user: AuthenticatedApiUser; hive: { id: string; kind: HiveKind } };

async function resolveHiveAccess(paramsPromise: Promise<{ id: string }>): Promise<HiveAccess> {
  const authz = await requireApiUser();
  if ("response" in authz) return { response: authz.response };

  const { id } = await paramsPromise;
  if (!id) return { response: jsonError("hive id is required", 400) };

  const [hive] = await sql<{ id: string; kind: string | null }[]>`
    SELECT id, kind FROM hives WHERE id = ${id}
  `;
  if (!hive) return { response: jsonError("hive not found", 404) };

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) {
      return { response: jsonError("Forbidden: hive access required", 403) };
    }
  }

  return {
    user: authz.user,
    hive: {
      id: hive.id,
      kind: normalizeHiveKind(hive.kind),
    },
  };
}
