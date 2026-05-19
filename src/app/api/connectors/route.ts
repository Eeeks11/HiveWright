import { canAccessHive } from "@/auth/users";
import { listConnectorDefinitions, listConnectorDefinitionsForHive, toPublicConnector } from "@/connectors/registry";
import { requireApiAuth, requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";

/**
 * GET /api/connectors — the public catalog (metadata only, never handlers
 * or secrets). Powers the connector browser on /setup/connectors.
 */
export async function GET(request: Request) {
  const hiveId = new URL(request.url).searchParams.get("hiveId")?.trim();
  if (hiveId) {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden", 403);
    }
    return jsonOk((await listConnectorDefinitionsForHive(sql, hiveId)).map(toPublicConnector));
  }

  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  return jsonOk(listConnectorDefinitions().map(toPublicConnector));
}
