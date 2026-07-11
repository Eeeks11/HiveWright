import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { bootstrapFirstOwner } from "@/auth/owner-bootstrap";
import {
  removeOwnerSetupTokenFromSecrets,
  runtimeSecretsPath,
} from "@/auth/owner-bootstrap-provisioning";

const DENIED_MESSAGE = "Unable to create owner account.";

function requestSource(request: Request): string {
  return request.headers.get("x-real-ip")
    ?? request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

/**
 * POST /api/auth/bootstrap-owner — one-shot, only usable when the `users`
 * table is empty and the caller proves possession of the local one-time
 * setup token. Subsequent users are added via the authenticated admin flow.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { email, password, displayName, setupToken } = body as {
      email?: string;
      password?: string;
      displayName?: string;
      setupToken?: string;
    };
    const result = await bootstrapFirstOwner(sql, {
      email: email ?? "",
      password: password ?? "",
      displayName,
      setupToken: setupToken ?? "",
      source: requestSource(request),
    });
    if (!result.ok) return jsonError(DENIED_MESSAGE, 403);
    const { user } = result;
    try {
      removeOwnerSetupTokenFromSecrets(runtimeSecretsPath());
    } catch {
      // Database consumption is authoritative. Avoid exposing paths or secrets.
      console.warn("[api/auth/bootstrap-owner] setup secret cleanup requires operator attention");
    }
    return jsonOk(
      { id: user.id, email: user.email, displayName: user.displayName },
      201,
    );
  } catch (err) {
    console.error("[api/auth/bootstrap-owner] request failed", {
      kind: err instanceof Error ? err.constructor.name : "UnknownError",
    });
    return jsonError(DENIED_MESSAGE, 403);
  }
}
