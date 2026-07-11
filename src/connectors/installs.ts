import type { Sql } from "postgres";
import { sanitizeAuditString } from "@/actions/redaction";
import { storeCredential } from "@/credentials/manager";
import {
  getConnectorDefinitionForHive,
  type ConnectorDefinition,
  type ConnectorScopeDeclaration,
} from "@/connectors/registry";
import {
  DEFAULT_EA_FALLBACK_MODEL,
  DEFAULT_EA_PRIMARY_MODEL,
  getEaModelConfiguration,
  updateEaModelConfiguration,
} from "@/ea/native/model-selection";

export type ConnectorInstallStatus = "active" | "disabled" | "broken";

type SqlExecutor = Sql;
type SqlJsonValue = Parameters<Sql["json"]>[0];

export class ConnectorInstallError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectorInstallError";
    this.status = status;
  }
}

export interface ConnectorInstallRow {
  id: string;
  hiveId: string;
  connectorSlug: string;
  displayName: string;
  config: Record<string, unknown> | null;
  grantedScopes: string[] | null;
  credentialId: string | null;
  status: string;
  lastTestedAt: Date | string | null;
  lastError: string | null;
  lastSyncedAt?: Date | string | null;
  lastSyncError?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  successes7d?: number | string;
  errors7d?: number | string;
}

export interface OwnerConnectorInstallSummary {
  id: string;
  hiveId: string;
  connectorSlug: string;
  connectorName: string | null;
  displayName: string;
  config: Record<string, unknown>;
  grantedScopes: string[];
  credentialConfigured: boolean;
  status: string;
  lastTestedAt: Date | string | null;
  lastError: string | null;
  lastSyncedAt: Date | string | null;
  lastSyncError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  successes7d: number;
  errors7d: number;
  capabilities: string[];
}

export interface CreateConnectorInstallInput {
  hiveId: string;
  connectorSlug: string;
  displayName: string;
  fields: Record<string, unknown>;
  grantedScopes?: unknown;
}

export interface UpdateConnectorInstallInput {
  hiveId: string;
  installId: string;
  status?: "active" | "disabled";
  displayName?: string;
  fields?: Record<string, unknown>;
  grantedScopes?: unknown;
}

export interface SetConnectorInstallStatusInput {
  installId: string;
  hiveId?: string;
  status: ConnectorInstallStatus;
  tested?: boolean;
  lastError?: string | null;
}

function toSqlJson(value: unknown): SqlJsonValue {
  return JSON.parse(JSON.stringify(value)) as SqlJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseCount(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  return 0;
}

const EA_CONNECTOR_SLUGS = new Set(["ea-discord", "voice-ea"]);

async function persistSharedEaModelConfiguration(
  sql: SqlExecutor,
  hiveId: string,
  connectorSlug: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!EA_CONNECTOR_SLUGS.has(connectorSlug)) return;
  const existing = await getEaModelConfiguration(sql, hiveId);
  const hasExplicitModel = Object.prototype.hasOwnProperty.call(fields, "model");
  const explicitModel = typeof fields.model === "string" && fields.model.trim()
    ? fields.model
    : null;
  await updateEaModelConfiguration(sql, hiveId, {
    primaryModel: hasExplicitModel
      ? explicitModel
      : existing.primaryModel ?? DEFAULT_EA_PRIMARY_MODEL,
    fallbackModel: existing.fallbackModel ?? DEFAULT_EA_FALLBACK_MODEL,
  });
}

function normalizeGrantedScopes(definition: ConnectorDefinition, requested: unknown): string[] {
  const requestedScopes: unknown[] = Array.isArray(requested) ? requested : [];
  if (!requestedScopes.every((scope) => typeof scope === "string")) {
    throw new ConnectorInstallError("grantedScopes must be an array of strings");
  }

  const declaredScopes = new Set(definition.scopes.map((scope: ConnectorScopeDeclaration) => scope.key));
  const unknownScope = requestedScopes.find((scope): scope is string => typeof scope === "string" && !declaredScopes.has(scope));
  if (unknownScope) {
    throw new ConnectorInstallError(`unknown scope for ${definition.slug}: ${unknownScope}`);
  }

  return Array.from(new Set([
    ...definition.scopes.filter((scope) => scope.required).map((scope) => scope.key),
    ...(requestedScopes as string[]),
  ]));
}

function validateRequiredFields(definition: ConnectorDefinition, fields: Record<string, unknown>) {
  for (const field of definition.setupFields) {
    if (!field.required) continue;
    const value = fields[field.key];
    if (value === undefined || value === null || value === "") {
      throw new ConnectorInstallError(`Missing required field: ${field.label}`);
    }
  }
}

function splitInstallFields(
  definition: ConnectorDefinition,
  fields: Record<string, unknown>,
  existingConfig: Record<string, unknown> = {},
): { publicConfig: Record<string, unknown>; secretValues: Record<string, string> } {
  const secretFields = new Set(definition.secretFields);
  const setupFieldKeys = new Set(definition.setupFields.map((field) => field.key));
  const publicConfig: Record<string, unknown> = { ...existingConfig };
  const secretValues: Record<string, string> = {};

  for (const field of definition.setupFields) {
    if (!Object.prototype.hasOwnProperty.call(fields, field.key)) continue;
    const value = fields[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (secretFields.has(field.key)) {
      secretValues[field.key] = String(value);
    } else {
      publicConfig[field.key] = value;
    }
  }

  for (const key of Object.keys(publicConfig)) {
    if (secretFields.has(key) || !setupFieldKeys.has(key)) {
      delete publicConfig[key];
    }
  }

  return { publicConfig, secretValues };
}

async function storeInstallSecrets(
  sql: SqlExecutor,
  hiveId: string,
  definition: ConnectorDefinition,
  displayName: string,
  secretValues: Record<string, string>,
): Promise<string | null> {
  if (Object.keys(secretValues).length === 0) return null;
  const encryptionKey = process.env.ENCRYPTION_KEY || "";
  if (!encryptionKey) {
    throw new ConnectorInstallError("ENCRYPTION_KEY not configured - cannot store secrets", 500);
  }
  const credential = await storeCredential(sql, {
    hiveId,
    name: `${definition.name}: ${displayName}`,
    key: `connector:${definition.slug}:${Date.now()}`,
    value: JSON.stringify(secretValues),
    rolesAllowed: [],
    encryptionKey,
  });
  return credential.id;
}

export function redactConnectorInstallForOwner(
  row: ConnectorInstallRow,
  definition?: ConnectorDefinition,
): OwnerConnectorInstallSummary {
  const secretFields = new Set(definition?.secretFields ?? []);
  const config = Object.fromEntries(
    Object.entries(asRecord(row.config)).filter(([key]) => !secretFields.has(key)),
  );
  return {
    id: row.id,
    hiveId: row.hiveId,
    connectorSlug: row.connectorSlug,
    connectorName: definition?.name ?? null,
    displayName: row.displayName,
    config,
    grantedScopes: asStringArray(row.grantedScopes),
    credentialConfigured: Boolean(row.credentialId),
    status: row.status,
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError ? sanitizeAuditString(row.lastError) : null,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastSyncError: row.lastSyncError ? sanitizeAuditString(row.lastSyncError) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    successes7d: parseCount(row.successes7d),
    errors7d: parseCount(row.errors7d),
    capabilities: definition?.capabilities ?? ["health"],
  };
}

export async function listConnectorInstalls(
  sql: SqlExecutor,
  input: { hiveId: string },
): Promise<OwnerConnectorInstallSummary[]> {
  const rows = await sql<ConnectorInstallRow[]>`
    SELECT
      ci.id,
      ci.hive_id        AS "hiveId",
      ci.connector_slug AS "connectorSlug",
      ci.display_name   AS "displayName",
      ci.config,
      ci.granted_scopes AS "grantedScopes",
      ci.credential_id  AS "credentialId",
      ci.status,
      ci.last_tested_at AS "lastTestedAt",
      ci.last_error     AS "lastError",
      (SELECT MAX(csc.last_synced_at)
         FROM connector_sync_cursors csc
        WHERE csc.install_id = ci.id) AS "lastSyncedAt",
      (SELECT csc.last_error
         FROM connector_sync_cursors csc
        WHERE csc.install_id = ci.id AND csc.last_error IS NOT NULL
        ORDER BY csc.last_synced_at DESC NULLS LAST, csc.updated_at DESC
        LIMIT 1) AS "lastSyncError",
      ci.created_at     AS "createdAt",
      ci.updated_at     AS "updatedAt",
      (SELECT COUNT(*)::int FROM connector_events ce
         WHERE ce.install_id = ci.id AND ce.status = 'success'
           AND ce.created_at > NOW() - INTERVAL '7 days') AS "successes7d",
      (SELECT COUNT(*)::int FROM connector_events ce
         WHERE ce.install_id = ci.id AND ce.status = 'error'
           AND ce.created_at > NOW() - INTERVAL '7 days') AS "errors7d"
    FROM connector_installs ci
    WHERE ci.hive_id = ${input.hiveId}::uuid
    ORDER BY ci.created_at DESC
  `;

  const summaries: OwnerConnectorInstallSummary[] = [];
  for (const row of rows) {
    const definition = await getConnectorDefinitionForHive(sql, input.hiveId, row.connectorSlug);
    summaries.push(redactConnectorInstallForOwner(row, definition));
  }
  return summaries;
}

export async function createConnectorInstall(
  sql: SqlExecutor,
  input: CreateConnectorInstallInput,
): Promise<OwnerConnectorInstallSummary> {
  const definition = await getConnectorDefinitionForHive(sql, input.hiveId, input.connectorSlug);
  if (!definition) {
    throw new ConnectorInstallError(`unknown or disabled connector for hive: ${input.connectorSlug}`);
  }

  validateRequiredFields(definition, input.fields);
  const grantedScopes = normalizeGrantedScopes(definition, input.grantedScopes);
  const { publicConfig, secretValues } = splitInstallFields(definition, input.fields);
  const credentialId = await storeInstallSecrets(sql, input.hiveId, definition, input.displayName, secretValues);

  const [row] = await sql<ConnectorInstallRow[]>`
    INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, granted_scopes, credential_id)
    VALUES (
      ${input.hiveId}::uuid,
      ${definition.slug},
      ${input.displayName},
      ${sql.json(toSqlJson(publicConfig))},
      ${sql.json(toSqlJson(grantedScopes))},
      ${credentialId}
    )
    RETURNING
      id,
      hive_id AS "hiveId",
      connector_slug AS "connectorSlug",
      display_name AS "displayName",
      config,
      granted_scopes AS "grantedScopes",
      credential_id AS "credentialId",
      status,
      last_tested_at AS "lastTestedAt",
      last_error AS "lastError",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `;

  await persistSharedEaModelConfiguration(sql, input.hiveId, definition.slug, input.fields);

  return redactConnectorInstallForOwner(row, definition);
}

export async function updateConnectorInstall(
  sql: SqlExecutor,
  input: UpdateConnectorInstallInput,
): Promise<OwnerConnectorInstallSummary> {
  if (input.status && !["active", "disabled"].includes(input.status)) {
    throw new ConnectorInstallError("status must be active or disabled");
  }

  const [existing] = await sql<ConnectorInstallRow[]>`
    SELECT
      id,
      hive_id AS "hiveId",
      connector_slug AS "connectorSlug",
      display_name AS "displayName",
      config,
      granted_scopes AS "grantedScopes",
      credential_id AS "credentialId",
      status,
      last_tested_at AS "lastTestedAt",
      last_error AS "lastError",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM connector_installs
    WHERE id = ${input.installId} AND hive_id = ${input.hiveId}::uuid
  `;
  if (!existing) throw new ConnectorInstallError("install not found", 404);

  const definition = await getConnectorDefinitionForHive(sql, input.hiveId, existing.connectorSlug);
  if (!definition) throw new ConnectorInstallError(`unknown connector ${existing.connectorSlug}`);

  const displayName = input.displayName ?? existing.displayName;
  const grantedScopes = input.grantedScopes === undefined
    ? asStringArray(existing.grantedScopes)
    : normalizeGrantedScopes(definition, input.grantedScopes);
  const { publicConfig, secretValues } = splitInstallFields(
    definition,
    input.fields ?? {},
    asRecord(existing.config),
  );
  const replacementCredentialId = await storeInstallSecrets(sql, input.hiveId, definition, displayName, secretValues);
  const credentialId = replacementCredentialId ?? existing.credentialId;
  const status = input.status ?? existing.status;

  const [row] = await sql<ConnectorInstallRow[]>`
    UPDATE connector_installs
    SET
      display_name = ${displayName},
      config = ${sql.json(toSqlJson(publicConfig))},
      granted_scopes = ${sql.json(toSqlJson(grantedScopes))},
      credential_id = ${credentialId},
      status = ${status},
      updated_at = NOW()
    WHERE id = ${input.installId} AND hive_id = ${input.hiveId}::uuid
    RETURNING
      id,
      hive_id AS "hiveId",
      connector_slug AS "connectorSlug",
      display_name AS "displayName",
      config,
      granted_scopes AS "grantedScopes",
      credential_id AS "credentialId",
      status,
      last_tested_at AS "lastTestedAt",
      last_error AS "lastError",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `;

  if (input.fields) {
    await persistSharedEaModelConfiguration(sql, input.hiveId, definition.slug, input.fields);
  }

  return redactConnectorInstallForOwner(row, definition);
}

export async function setConnectorInstallStatus(
  sql: SqlExecutor,
  input: SetConnectorInstallStatusInput,
): Promise<void> {
  if (!["active", "disabled", "broken"].includes(input.status)) {
    throw new ConnectorInstallError("unsupported connector install status");
  }
  const lastError = input.lastError ? sanitizeAuditString(input.lastError) : null;
  if (input.hiveId) {
    await sql`
      UPDATE connector_installs
      SET
        status = ${input.status},
        last_tested_at = CASE WHEN ${input.tested === true} THEN NOW() ELSE last_tested_at END,
        last_error = ${lastError},
        updated_at = NOW()
      WHERE id = ${input.installId} AND hive_id = ${input.hiveId}::uuid
    `;
    return;
  }
  await sql`
    UPDATE connector_installs
    SET
      status = ${input.status},
      last_tested_at = CASE WHEN ${input.tested === true} THEN NOW() ELSE last_tested_at END,
      last_error = ${lastError},
      updated_at = NOW()
    WHERE id = ${input.installId}
  `;
}
