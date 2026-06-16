import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { listGlobalRoleTemplates } from "../_service";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const searchParams = new URL(request.url).searchParams;
    const includeInactive = searchParams.get("includeInactive") === "true";
    return jsonOk(await listGlobalRoleTemplates(includeInactive));
  } catch {
    return jsonError("Failed to fetch global roles", 500);
  }
}
