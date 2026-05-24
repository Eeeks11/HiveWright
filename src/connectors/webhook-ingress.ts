import { createHash, randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { sanitizeAuditString } from "@/actions/redaction";
import {
  importExternalRecords,
  type ExternalRecordFamily,
  type ExternalRecordImportError,
} from "@/hives/external-record-adapters";
import type { HiveRecord } from "@/hives/records";

type WebhookIngressSql = Sql | TransactionSql;

export class ConnectorWebhookIngressError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectorWebhookIngressError";
    this.status = status;
  }
}

export interface CreateWebhookIngressTokenInput {
  installId: string;
  stream?: string | null;
  label?: string | null;
}

export interface CreatedWebhookIngressToken {
  id: string;
  installId: string;
  stream: string;
  label: string | null;
  token: string;
  tokenPrefix: string;
  createdAt: Date | string;
}

export interface IngestConnectorWebhookInput {
  installId: string;
  token: string;
  stream?: string | null;
  externalId: string;
  family: ExternalRecordFamily | string;
  occurredAt?: Date | string | null;
  payload: Record<string, unknown>;
}

export interface ConnectorWebhookIngressResult {
  installId: string;
  hiveId: string;
  connectorSlug: string;
  stream: string;
  imported: number;
  updated: number;
  rejected: number;
  errors: ExternalRecordImportError[];
  records: HiveRecord[];
}

interface InstallRow {
  id: string;
  hiveId: string;
}

interface TokenLookupRow {
  tokenId: string;
  tokenStream: string;
  installId: string;
  hiveId: string;
  hiveKind: string | null;
  connectorSlug: string;
  installStatus: string;
}

function webhookTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createOpaqueWebhookToken(): string {
  return `hwwh_${randomBytes(32).toString("base64url")}`;
}

function normalizeStream(value: unknown): string {
  const stream = typeof value === "string" ? value.trim() : "";
  if (!stream) return "default";
  if (stream.length > 128) throw new ConnectorWebhookIngressError("stream must be 128 characters or fewer");
  return stream;
}

function normalizeLabel(value: unknown): string | null {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label) return null;
  return label.slice(0, 255);
}

function requiredString(value: unknown, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new ConnectorWebhookIngressError(`${field} is required`);
  return trimmed;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorWebhookIngressError("payload must be an object");
  }
  return value as Record<string, unknown>;
}

function normalizeOccurredAt(value: Date | string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function installStatusError(status: string): ConnectorWebhookIngressError | null {
  if (status === "active") return null;
  if (status === "disabled") {
    return new ConnectorWebhookIngressError("connector install is disabled", 409);
  }
  if (status === "broken") {
    return new ConnectorWebhookIngressError("connector install is broken", 409);
  }
  return new ConnectorWebhookIngressError("connector install is not active", 409);
}

async function logWebhookEvent(
  sql: WebhookIngressSql,
  input: {
    installId: string;
    status: "success" | "error";
    errorText?: string | null;
    startedAt: number;
  },
): Promise<void> {
  const durationMs = Math.max(0, Date.now() - input.startedAt);
  await sql`
    INSERT INTO connector_events (install_id, operation, status, duration_ms, error_text, actor)
    VALUES (
      ${input.installId}::uuid,
      'webhook_ingest',
      ${input.status},
      ${durationMs},
      ${input.errorText ? sanitizeAuditString(input.errorText) : null},
      'webhook'
    )
  `;
}

export async function createWebhookIngressToken(
  sql: WebhookIngressSql,
  input: CreateWebhookIngressTokenInput,
): Promise<CreatedWebhookIngressToken> {
  const stream = normalizeStream(input.stream);
  const label = normalizeLabel(input.label);
  const [install] = await sql<InstallRow[]>`
    SELECT id, hive_id AS "hiveId"
    FROM connector_installs
    WHERE id = ${input.installId}::uuid
    LIMIT 1
  `;
  if (!install) throw new ConnectorWebhookIngressError("connector install not found", 404);

  const token = createOpaqueWebhookToken();
  const tokenHash = webhookTokenHash(token);
  const [row] = await sql<{
    id: string;
    installId: string;
    stream: string;
    label: string | null;
    createdAt: Date | string;
  }[]>`
    INSERT INTO connector_webhook_tokens (install_id, stream, label, token_hash)
    VALUES (${input.installId}::uuid, ${stream}, ${label}, ${tokenHash})
    ON CONFLICT (install_id, stream)
    DO UPDATE SET
      label = EXCLUDED.label,
      token_hash = EXCLUDED.token_hash,
      revoked_at = NULL,
      updated_at = NOW()
    RETURNING
      id,
      install_id AS "installId",
      stream,
      label,
      created_at AS "createdAt"
  `;

  return {
    id: row.id,
    installId: row.installId,
    stream: row.stream,
    label: row.label,
    token,
    tokenPrefix: token.slice(0, 10),
    createdAt: row.createdAt,
  };
}

export async function ingestConnectorWebhook(
  sql: WebhookIngressSql,
  input: IngestConnectorWebhookInput,
): Promise<ConnectorWebhookIngressResult> {
  const startedAt = Date.now();
  const token = requiredString(input.token, "token");
  const requestedStream = input.stream === undefined || input.stream === null
    ? null
    : normalizeStream(input.stream);
  const externalId = requiredString(input.externalId, "externalId");
  const family = requiredString(input.family, "family");
  const payload = plainObject(input.payload);
  const tokenHash = webhookTokenHash(token);

  const [lookup] = await sql<TokenLookupRow[]>`
    SELECT
      cwt.id AS "tokenId",
      cwt.stream AS "tokenStream",
      ci.id AS "installId",
      ci.hive_id AS "hiveId",
      h.kind AS "hiveKind",
      ci.connector_slug AS "connectorSlug",
      ci.status AS "installStatus"
    FROM connector_webhook_tokens cwt
    JOIN connector_installs ci ON ci.id = cwt.install_id
    JOIN hives h ON h.id = ci.hive_id
    WHERE cwt.install_id = ${input.installId}::uuid
      AND cwt.token_hash = ${tokenHash}
      AND cwt.revoked_at IS NULL
    LIMIT 1
  `;

  if (!lookup) {
    throw new ConnectorWebhookIngressError("invalid webhook token", 401);
  }

  const stream = requestedStream ?? lookup.tokenStream;
  if (stream !== lookup.tokenStream) {
    throw new ConnectorWebhookIngressError(`webhook token is not valid for stream ${stream}`, 403);
  }

  const statusError = installStatusError(lookup.installStatus);
  if (statusError) throw statusError;

  try {
    const result = await importExternalRecords(sql, {
      hiveId: lookup.hiveId,
      hiveKind: lookup.hiveKind ?? "business",
      connectorInstallId: lookup.installId,
      sourceConnector: lookup.connectorSlug,
      items: [{
        stream,
        externalId,
        occurredAt: normalizeOccurredAt(input.occurredAt),
        payload: {
          ...payload,
          family,
          stream,
        },
      }],
    });

    if (result.rejected > 0) {
      const message = result.errors[0]?.message ?? "webhook payload rejected";
      throw new ConnectorWebhookIngressError(message, 422);
    }

    await sql`
      UPDATE connector_webhook_tokens
      SET last_used_at = NOW(), updated_at = NOW()
      WHERE id = ${lookup.tokenId}::uuid
    `;
    await logWebhookEvent(sql, {
      installId: lookup.installId,
      status: "success",
      startedAt,
    });

    return {
      installId: lookup.installId,
      hiveId: lookup.hiveId,
      connectorSlug: lookup.connectorSlug,
      stream,
      imported: result.imported,
      updated: result.updated,
      rejected: result.rejected,
      errors: result.errors,
      records: result.records,
    };
  } catch (error) {
    if (error instanceof ConnectorWebhookIngressError) {
      await logWebhookEvent(sql, {
        installId: lookup.installId,
        status: "error",
        errorText: error.message,
        startedAt,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : "webhook payload rejected";
    await logWebhookEvent(sql, {
      installId: lookup.installId,
      status: "error",
      errorText: message,
      startedAt,
    });
    throw new ConnectorWebhookIngressError(message, 422);
  }
}
