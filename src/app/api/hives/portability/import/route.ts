import { importHiveTemplate, type HivePortablePackage } from "@/hives/portability";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) return jsonError("Forbidden: system owner role required", 403);

  try {
    const body = await request.json() as {
      package?: HivePortablePackage;
      hivePackage?: HivePortablePackage;
      slug?: string;
      name?: string;
      env?: Record<string, string | undefined>;
      collisionStrategy?: "reject" | "rename";
    };
    const pkg = body.package ?? body.hivePackage;
    if (!pkg) return jsonError("package is required", 400);
    if (!body.slug || !body.name) return jsonError("slug and name are required", 400);

    return jsonOk(await importHiveTemplate(sql, pkg, {
      slug: body.slug,
      name: body.name,
      env: body.env,
      collisionStrategy: body.collisionStrategy,
    }), 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to import hive template";
    return jsonError(message, /unsupported|invalid|required|cannot be imported/i.test(message) ? 400 : 500);
  }
}
