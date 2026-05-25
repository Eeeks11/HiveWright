import { canAccessHive } from "@/auth/users";
import { exportHiveTemplate } from "@/hives/portability";
import { requireApiUser } from "../../../../_lib/auth";
import { sql } from "../../../../_lib/db";
import { jsonError, jsonOk } from "../../../../_lib/responses";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleExport(params);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleExport(params);
}

async function handleExport(paramsPromise: Promise<{ id: string }>) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await paramsPromise;
  if (!id) return jsonError("hive id is required", 400);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  try {
    return jsonOk(await exportHiveTemplate(sql, id));
  } catch (error) {
    const message = error instanceof Error && error.message === "Hive not found"
      ? "Hive not found"
      : "Failed to export hive template";
    return jsonError(message, message === "Hive not found" ? 404 : 500);
  }
}
