import { requireSystemOwner } from "../../_lib/auth";
import { jsonError, jsonOk } from "../../_lib/responses";
import { defaultEnvFilePath, upsertEnvFileValue } from "@/lib/env-file";

const GOOGLE_CLIENT_ID_ENV = "GOOGLE_CLIENT_ID";
const GOOGLE_CLIENT_SECRET_ENV = "GOOGLE_CLIENT_SECRET";

interface OAuthProviderStatus {
  provider: "google";
  configured: boolean;
  clientIdPresent: boolean;
  clientSecretPresent: boolean;
  clientIdPreview: string | null;
  redirectUri: string;
  envFilePath: string;
  restartRequired: boolean;
}

export async function GET(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  return jsonOk(buildGoogleProviderStatus(request));
}

export async function PATCH(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("JSON body required", 400);
  }

  if (!body || typeof body !== "object") return jsonError("JSON object body required", 400);
  const input = body as Record<string, unknown>;
  const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "google";
  if (provider !== "google") return jsonError("Only google OAuth provider config is supported", 400);

  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  if (!clientId) return jsonError("clientId is required", 400);
  if (!clientSecret) return jsonError("clientSecret is required", 400);

  try {
    const idWrite = upsertEnvFileValue(GOOGLE_CLIENT_ID_ENV, clientId);
    upsertEnvFileValue(GOOGLE_CLIENT_SECRET_ENV, clientSecret);
    process.env.GOOGLE_CLIENT_ID = clientId;
    process.env.GOOGLE_CLIENT_SECRET = clientSecret;

    return jsonOk({
      ...buildGoogleProviderStatus(request, idWrite.envFilePath),
      restartRequired: false,
      message: "Google OAuth provider saved. Gmail connector setup can use it immediately.",
    });
  } catch (err) {
    console.error("[oauth provider-config PATCH] failed", err);
    return jsonError("Failed to save Google OAuth provider config", 500);
  }
}

function buildGoogleProviderStatus(
  request: Request,
  envFilePath = defaultEnvFilePath(),
): OAuthProviderStatus {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? process.env.GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? process.env.GMAIL_CLIENT_SECRET ?? "";
  return {
    provider: "google",
    configured: Boolean(clientId && clientSecret),
    clientIdPresent: Boolean(clientId),
    clientSecretPresent: Boolean(clientSecret),
    clientIdPreview: previewClientId(clientId),
    redirectUri: `${baseUrlFor(request)}/api/oauth/callback`,
    envFilePath,
    restartRequired: false,
  };
}

function baseUrlFor(request: Request): string {
  const base = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3002}`;
  return base.replace(/\/$/, "") || new URL(request.url).origin;
}

function previewClientId(clientId: string): string | null {
  if (!clientId) return null;
  if (clientId.length <= 8) return "••••";
  return `${clientId.slice(0, 6)}…${clientId.slice(-4)}`;
}
