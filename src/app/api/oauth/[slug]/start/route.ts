import { NextResponse } from "next/server";
import { canAccessHive } from "@/auth/users";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { jsonError } from "../../../_lib/responses";
import { getConnectorDefinition } from "@/connectors/registry";
import {
  buildAuthorizeUrl,
  missingOAuthClientMessage,
  resolveOAuthClient,
  storeState,
} from "@/connectors/oauth";

/**
 * GET /api/oauth/:slug/start?hiveId=…&displayName=…&redirectTo=…
 *
 * Kicks off the OAuth dance: stores a state token, then 302-redirects to
 * the provider's authorize URL. The callback route below closes the loop.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { slug } = await ctx.params;
  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  const displayName = url.searchParams.get("displayName") ?? "";
  const redirectTo = url.searchParams.get("redirectTo") ?? "/setup/connectors";

  if (!hiveId) return jsonError("hiveId required", 400);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  const def = getConnectorDefinition(slug);
  if (!def || !def.oauth) return jsonError(`${slug} is not an oauth connector`, 400);

  if (!resolveOAuthClient(def.oauth)) {
    const message = missingOAuthClientMessage(slug, def.oauth);
    if (request.headers.get("accept")?.includes("text/html")) {
      const failureUrl = safeRedirectUrl(request.url, redirectTo);
      failureUrl.searchParams.set("oauth_error", message);
      failureUrl.searchParams.set("oauth_setup_required", slug);
      return NextResponse.redirect(failureUrl, 302);
    }
    return NextResponse.json(
      { error: message, code: "oauth_client_not_configured" },
      { status: 503 },
    );
  }

  const state = await storeState(sql, {
    hiveId,
    connectorSlug: slug,
    displayName: displayName || def.name,
    redirectTo,
  });

  const authorizeUrl = buildAuthorizeUrl(def, state);
  return NextResponse.redirect(authorizeUrl, 302);
}

function safeRedirectUrl(requestUrl: string, redirectTo: string): URL {
  const origin = publicBaseOrigin() ?? new URL(requestUrl).origin;
  if (!redirectTo.startsWith("/") || redirectTo.startsWith("//")) {
    return new URL("/setup/connectors", origin);
  }
  return new URL(redirectTo, origin);
}

function publicBaseOrigin(): string | null {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return configured.replace(/\/$/, "");
  }
}
