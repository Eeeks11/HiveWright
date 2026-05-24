import type { Sql } from "postgres";
import { sanitizeAuditString } from "@/actions/redaction";

type SqlExecutor = Sql;

export interface ConnectorSyncCursorRow {
  id: string;
  installId: string;
  stream: string;
  cursor: string | null;
  lastSyncedAt: Date | string | null;
  lastError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ConnectorSyncCursorInput {
  installId: string;
  stream: string;
}

export interface UpsertConnectorSyncCursorInput extends ConnectorSyncCursorInput {
  cursor?: string | null;
  lastSyncedAt?: Date | string | null;
  lastError?: string | null;
}

export interface MarkConnectorSyncSuccessInput extends ConnectorSyncCursorInput {
  cursor?: string | null;
  lastSyncedAt?: Date | string | null;
}

export interface MarkConnectorSyncFailureInput extends ConnectorSyncCursorInput {
  cursor?: string | null;
  lastError: string;
}

function normalizeStream(stream: string): string {
  const normalized = stream.trim();
  if (!normalized) throw new Error("stream is required");
  return normalized;
}

function sanitizeError(error: string | null | undefined): string | null {
  return error ? sanitizeAuditString(error) : null;
}

export async function getConnectorSyncCursor(
  sql: SqlExecutor,
  input: ConnectorSyncCursorInput,
): Promise<ConnectorSyncCursorRow | null> {
  const [row] = await sql<ConnectorSyncCursorRow[]>`
    SELECT
      id,
      install_id      AS "installId",
      stream,
      cursor,
      last_synced_at  AS "lastSyncedAt",
      last_error      AS "lastError",
      created_at      AS "createdAt",
      updated_at      AS "updatedAt"
    FROM connector_sync_cursors
    WHERE install_id = ${input.installId}::uuid
      AND stream = ${normalizeStream(input.stream)}
  `;
  return row ?? null;
}

export async function upsertConnectorSyncCursor(
  sql: SqlExecutor,
  input: UpsertConnectorSyncCursorInput,
): Promise<ConnectorSyncCursorRow> {
  const [row] = await sql<ConnectorSyncCursorRow[]>`
    INSERT INTO connector_sync_cursors (
      install_id,
      stream,
      cursor,
      last_synced_at,
      last_error
    )
    VALUES (
      ${input.installId}::uuid,
      ${normalizeStream(input.stream)},
      ${input.cursor ?? null},
      ${input.lastSyncedAt ?? null},
      ${sanitizeError(input.lastError)}
    )
    ON CONFLICT (install_id, stream)
    DO UPDATE SET
      cursor = EXCLUDED.cursor,
      last_synced_at = EXCLUDED.last_synced_at,
      last_error = EXCLUDED.last_error,
      updated_at = NOW()
    RETURNING
      id,
      install_id      AS "installId",
      stream,
      cursor,
      last_synced_at  AS "lastSyncedAt",
      last_error      AS "lastError",
      created_at      AS "createdAt",
      updated_at      AS "updatedAt"
  `;
  return row;
}

export async function markConnectorSyncSuccess(
  sql: SqlExecutor,
  input: MarkConnectorSyncSuccessInput,
): Promise<ConnectorSyncCursorRow> {
  const existing = input.cursor === undefined ? await getConnectorSyncCursor(sql, input) : null;
  return upsertConnectorSyncCursor(sql, {
    installId: input.installId,
    stream: input.stream,
    cursor: input.cursor === undefined ? existing?.cursor ?? null : input.cursor,
    lastSyncedAt: input.lastSyncedAt ?? new Date(),
    lastError: null,
  });
}

export async function markConnectorSyncFailure(
  sql: SqlExecutor,
  input: MarkConnectorSyncFailureInput,
): Promise<ConnectorSyncCursorRow> {
  const existing = await getConnectorSyncCursor(sql, input);
  return upsertConnectorSyncCursor(sql, {
    installId: input.installId,
    stream: input.stream,
    cursor: input.cursor ?? existing?.cursor ?? null,
    lastSyncedAt: existing?.lastSyncedAt ?? null,
    lastError: input.lastError,
  });
}
