import type { Sql } from "postgres";
import { sanitizeAuditString } from "@/actions/redaction";
import type {
  ConnectorDefinition,
  ConnectorOperation,
  ConnectorSyncItem,
  ConnectorSyncResult,
} from "@/connectors/plugin-sdk";
import { getConnectorDefinition } from "@/connectors/registry";
import { importExternalRecords, type ExternalRecordImportError } from "@/hives/external-record-adapters";
import { normalizeHiveKind, type HiveKind } from "@/hives/kind";
import { invokeConnectorReadOnlyOrSystem } from "@/connectors/runtime";
import {
  getConnectorSyncCursor,
  markConnectorSyncFailure,
  markConnectorSyncSuccess,
} from "@/connectors/sync-cursors";

type SqlExecutor = Sql;

export type { ConnectorSyncItem, ConnectorSyncResult } from "@/connectors/plugin-sdk";

export class ConnectorSyncError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectorSyncError";
    this.status = status;
  }
}

export interface SyncConnectorInstallInput {
  hiveId: string;
  installId: string;
  streams?: string[];
  actor?: string;
}

export interface ConnectorSyncStreamError {
  stream: string;
  error: string;
}

export interface ConnectorSyncImportError extends ExternalRecordImportError {
  stream: string;
}

export interface SyncConnectorInstallResult {
  installId: string;
  connectorSlug: string;
  success: boolean;
  itemCount: number;
  importedCount: number;
  updatedCount: number;
  rejectedCount: number;
  results: ConnectorSyncResult[];
  errors: ConnectorSyncStreamError[];
  importErrors: ConnectorSyncImportError[];
}

interface ConnectorInstallForSync {
  id: string;
  hiveId: string;
  hiveKind: HiveKind;
  connectorSlug: string;
  status: string;
}

function normalizeStreams(streams: string[] | undefined): string[] {
  const normalized = (streams && streams.length > 0 ? streams : ["default"])
    .map((stream) => stream.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSafeSyncOperation(operation: ConnectorOperation): boolean {
  return (operation.governance.effectType === "read" || operation.governance.effectType === "system")
    && operation.governance.defaultDecision === "allow"
    && operation.governance.externalSideEffect !== true;
}

function findSyncOperation(definition: ConnectorDefinition, stream: string): ConnectorOperation | null {
  const candidates = [`sync_${stream}`, "sync"];
  for (const slug of candidates) {
    const operation = definition.operations.find((candidate) => candidate.slug === slug);
    if (operation && isSafeSyncOperation(operation)) return operation;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asSyncItem(value: unknown, fallbackStream: string): ConnectorSyncItem | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.externalId !== "string") return null;
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const stream = typeof record.stream === "string" && record.stream.trim() ? record.stream : fallbackStream;
  const occurredAt = typeof record.occurredAt === "string" ? record.occurredAt : undefined;
  return {
    stream,
    externalId: record.externalId,
    occurredAt,
    payload,
  };
}

function asSyncResult(value: unknown, fallbackStream: string): ConnectorSyncResult | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.items)) return null;
  const stream = typeof record.stream === "string" && record.stream.trim() ? record.stream : fallbackStream;
  const items = record.items
    .map((item) => asSyncItem(item, stream))
    .filter((item): item is ConnectorSyncItem => Boolean(item));
  if (items.length !== record.items.length) return null;
  const nextCursor = typeof record.nextCursor === "string" || record.nextCursor === null
    ? record.nextCursor
    : undefined;
  return { stream, nextCursor, items };
}

function normalizeSyncResults(value: unknown, fallbackStream: string): ConnectorSyncResult[] {
  if (Array.isArray(value)) {
    const results = value.map((item) => asSyncResult(item, fallbackStream));
    if (results.some((result) => !result)) {
      throw new ConnectorSyncError(`connector returned invalid sync result for stream ${fallbackStream}`);
    }
    return results as ConnectorSyncResult[];
  }

  const result = asSyncResult(value, fallbackStream);
  if (!result) {
    throw new ConnectorSyncError(`connector returned invalid sync result for stream ${fallbackStream}`);
  }
  return [result];
}

export async function syncConnectorInstall(
  sql: SqlExecutor,
  input: SyncConnectorInstallInput,
): Promise<SyncConnectorInstallResult> {
  const streams = normalizeStreams(input.streams);
  if (streams.length === 0) {
    throw new ConnectorSyncError("streams must include at least one stream");
  }

  const [install] = await sql<ConnectorInstallForSync[]>`
    SELECT
      ci.id,
      ci.hive_id AS "hiveId",
      h.kind AS "hiveKind",
      ci.connector_slug AS "connectorSlug",
      ci.status
    FROM connector_installs ci
    JOIN hives h ON h.id = ci.hive_id
    WHERE ci.id = ${input.installId}::uuid
      AND ci.hive_id = ${input.hiveId}::uuid
  `;
  if (!install) {
    throw new ConnectorSyncError("connector install not found", 404);
  }
  if (install.status !== "active") {
    throw new ConnectorSyncError(`connector install is ${install.status}`, 409);
  }

  const definition = getConnectorDefinition(install.connectorSlug);
  if (!definition) {
    throw new ConnectorSyncError(`unknown connector ${install.connectorSlug}`, 400);
  }

  const hiveKind = normalizeHiveKind(install.hiveKind);
  const results: ConnectorSyncResult[] = [];
  const errors: ConnectorSyncStreamError[] = [];
  const importErrors: ConnectorSyncImportError[] = [];
  let importedCount = 0;
  let updatedCount = 0;
  let rejectedCount = 0;

  for (const stream of streams) {
    const operation = findSyncOperation(definition, stream);
    if (!operation) {
      throw new ConnectorSyncError(`connector has no safe sync operation for stream ${stream}`, 400);
    }

    const cursor = await getConnectorSyncCursor(sql, {
      installId: install.id,
      stream,
    });
    const result = await invokeConnectorReadOnlyOrSystem(sql, {
      installId: install.id,
      operation: operation.slug,
      args: {
        stream,
        cursor: cursor?.cursor ?? null,
      },
      actor: input.actor ?? "connector-sync",
    });

    if (!result.success) {
      const error = sanitizeAuditString(result.error ?? "sync failed");
      await markConnectorSyncFailure(sql, {
        installId: install.id,
        stream,
        lastError: error,
      });
      errors.push({ stream, error });
      continue;
    }

    try {
      const streamResults = normalizeSyncResults(result.data, stream);
      for (const streamResult of streamResults) {
        const importResult = await importExternalRecords(sql, {
          hiveId: install.hiveId,
          hiveKind,
          connectorInstallId: install.id,
          sourceConnector: install.connectorSlug,
          items: streamResult.items,
        });
        importedCount += importResult.imported;
        updatedCount += importResult.updated;
        rejectedCount += importResult.rejected;
        importErrors.push(...importResult.errors.map((error) => ({
          ...error,
          stream: streamResult.stream,
        })));
        await markConnectorSyncSuccess(sql, {
          installId: install.id,
          stream: streamResult.stream,
          cursor: streamResult.nextCursor,
          lastSyncedAt: new Date(),
        });
        results.push(streamResult);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = sanitizeAuditString(message);
      await markConnectorSyncFailure(sql, {
        installId: install.id,
        stream,
        lastError: error,
      });
      errors.push({ stream, error });
    }
  }

  return {
    installId: install.id,
    connectorSlug: install.connectorSlug,
    success: errors.length === 0 && importErrors.length === 0,
    itemCount: results.reduce((total, result) => total + result.items.length, 0),
    importedCount,
    updatedCount,
    rejectedCount,
    results,
    errors,
    importErrors,
  };
}
