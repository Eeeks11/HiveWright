import { sanitizeAuditString } from "@/actions/redaction";
import {
  ConnectorWebhookIngressError,
  ingestConnectorWebhook,
} from "@/connectors/webhook-ingress";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

function requireWebhookBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token?.trim()) return null;
  return token.trim();
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function ingressError(error: unknown) {
  const message = error instanceof Error
    ? sanitizeAuditString(error.message)
    : "Webhook ingress failed";
  const status = error instanceof ConnectorWebhookIngressError ? error.status : 500;
  return jsonError(message, status);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ installId: string }> },
) {
  const token = requireWebhookBearerToken(request);
  if (!token) return jsonError("missing webhook bearer token", 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("request body must be valid JSON", 400);
  }

  const externalId = stringOrNull(body.externalId);
  if (!externalId) return jsonError("externalId is required", 400);

  const family = stringOrNull(body.family);
  if (!family) return jsonError("family is required", 400);

  const payload = plainObject(body.payload);
  if (!payload) return jsonError("payload must be an object", 400);

  const stream = body.stream === undefined ? undefined : stringOrNull(body.stream);
  if (body.stream !== undefined && !stream) return jsonError("stream must be a non-empty string", 400);

  const occurredAt = body.occurredAt === undefined ? undefined : stringOrNull(body.occurredAt);
  if (body.occurredAt !== undefined && !occurredAt) return jsonError("occurredAt must be a non-empty string", 400);

  try {
    const { installId } = await ctx.params;
    const result = await ingestConnectorWebhook(sql, {
      installId,
      token,
      stream,
      externalId,
      family,
      occurredAt,
      payload,
    });
    return jsonOk(result);
  } catch (error) {
    if (!(error instanceof ConnectorWebhookIngressError)) {
      console.error("[api/connectors/webhook/:installId]", error);
    }
    return ingressError(error);
  }
}
