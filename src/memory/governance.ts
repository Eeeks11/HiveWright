import type { Sql, TransactionSql } from "postgres";
import { NextResponse } from "next/server";

const RECENT_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DELETED_SENTINEL = "00000000-0000-0000-0000-000000000000";

type QuerySql = Sql | TransactionSql;

type HiveMemoryGovernanceRow = {
  hive_id: string;
  memory_disabled: boolean;
  reason: string | null;
  changed_by: string | null;
  updated_at: Date | string | null;
  last_used_at: Date | string | null;
  last_write_at: Date | string | null;
  last_blocked_at: Date | string | null;
  last_blocked_operation: string | null;
  last_blocked_source: string | null;
};

export type MemoryGovernanceOperation = "read" | "write";

export interface HiveMemoryGovernanceState {
  hiveId: string;
  memoryEnabled: boolean;
  reason: string | null;
  changedBy: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  lastWriteAt: string | null;
  lastBlockedAt: string | null;
  lastBlockedOperation: string | null;
  lastBlockedSource: string | null;
  blocked: boolean;
  recentlyUsed: boolean;
  statusLabels: string[];
}

export interface HiveMemoryGovernanceSummary {
  hiveId: string;
  memoryEnabled: boolean;
  reason: string | null;
  changedBy: string | null;
  updatedAt: string | null;
  status: {
    enabled: boolean;
    disabled: boolean;
    blocked: boolean;
    recentlyUsed: boolean;
    labels: string[];
  };
  activity: {
    lastUsedAt: string | null;
    lastWriteAt: string | null;
    lastBlockedAt: string | null;
    lastBlockedOperation: string | null;
    lastBlockedSource: string | null;
  };
  counts: {
    roleMemory: number;
    hiveMemory: number;
    deletedRoleMemory: number;
    deletedHiveMemory: number;
  };
  scopeLabel: string;
}

export interface MemoryEntryScope {
  id: string;
  hiveId: string;
  store: "role_memory" | "hive_memory";
}

export interface SoftDeleteMemoryEntryResult extends MemoryEntryScope {
  status: "soft_deleted";
  deletedAt: string;
}

export const MEMORY_SCOPE_LABEL =
  "Scope: same-hive agent memory reuse and automatic writes only.";

export const MEMORY_DISABLED_ERROR = "Hive memory is disabled";

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecent(value: string | null): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp <= RECENT_ACTIVITY_WINDOW_MS;
}

function buildStatusLabels(input: {
  memoryEnabled: boolean;
  blocked: boolean;
  recentlyUsed: boolean;
}): string[] {
  const labels = [input.memoryEnabled ? "enabled" : "disabled"];
  if (input.blocked) labels.push("blocked");
  if (input.recentlyUsed) labels.push("recently used");
  return labels;
}

function normalizeState(
  hiveId: string,
  row?: HiveMemoryGovernanceRow | null,
): HiveMemoryGovernanceState {
  const memoryEnabled = !row?.memory_disabled;
  const lastUsedAt = iso(row?.last_used_at);
  const lastWriteAt = iso(row?.last_write_at);
  const lastBlockedAt = iso(row?.last_blocked_at);
  const recentlyUsed = isRecent(lastUsedAt) || isRecent(lastWriteAt);
  const blocked = lastBlockedAt !== null;

  return {
    hiveId,
    memoryEnabled,
    reason: row?.reason ?? null,
    changedBy: row?.changed_by ?? null,
    updatedAt: iso(row?.updated_at),
    lastUsedAt,
    lastWriteAt,
    lastBlockedAt,
    lastBlockedOperation: row?.last_blocked_operation ?? null,
    lastBlockedSource: row?.last_blocked_source ?? null,
    blocked,
    recentlyUsed,
    statusLabels: buildStatusLabels({ memoryEnabled, blocked, recentlyUsed }),
  };
}

export async function getHiveMemoryGovernanceState(
  db: QuerySql,
  hiveId: string,
): Promise<HiveMemoryGovernanceState> {
  const [row] = await db<HiveMemoryGovernanceRow[]>`
    SELECT
      hive_id,
      memory_disabled,
      reason,
      changed_by,
      updated_at,
      last_used_at,
      last_write_at,
      last_blocked_at,
      last_blocked_operation,
      last_blocked_source
    FROM hive_memory_governance
    WHERE hive_id = ${hiveId}::uuid
    LIMIT 1
  `;

  return normalizeState(hiveId, row ?? null);
}

export async function markMemoryUsed(db: QuerySql, hiveId: string): Promise<void> {
  await db`
    INSERT INTO hive_memory_governance (
      hive_id,
      memory_disabled,
      last_used_at,
      updated_at
    )
    VALUES (${hiveId}, false, NOW(), NOW())
    ON CONFLICT (hive_id)
    DO UPDATE SET
      last_used_at = NOW()
  `;
}

export async function markMemoryWritten(db: QuerySql, hiveId: string): Promise<void> {
  await db`
    INSERT INTO hive_memory_governance (
      hive_id,
      memory_disabled,
      last_write_at,
      updated_at
    )
    VALUES (${hiveId}, false, NOW(), NOW())
    ON CONFLICT (hive_id)
    DO UPDATE SET
      last_write_at = NOW()
  `;
}

export async function recordMemoryBlockedOperation(
  db: QuerySql,
  input: {
    hiveId: string;
    source: string;
    operation: MemoryGovernanceOperation;
    reason?: string | null;
  },
): Promise<void> {
  await db`
    INSERT INTO hive_memory_governance (
      hive_id,
      memory_disabled,
      reason,
      last_blocked_at,
      last_blocked_operation,
      last_blocked_source,
      updated_at
    )
    VALUES (
      ${input.hiveId},
      true,
      ${input.reason ?? null},
      NOW(),
      ${input.operation},
      ${input.source},
      NOW()
    )
    ON CONFLICT (hive_id)
    DO UPDATE SET
      last_blocked_at = NOW(),
      last_blocked_operation = EXCLUDED.last_blocked_operation,
      last_blocked_source = EXCLUDED.last_blocked_source,
      reason = COALESCE(hive_memory_governance.reason, EXCLUDED.reason)
  `;
}

export async function assertHiveMemoryWriteAllowed(
  db: QuerySql,
  input: {
    hiveId: string;
    source: string;
    operation?: MemoryGovernanceOperation;
  },
): Promise<{ allowed: true; governance: HiveMemoryGovernanceState } | { allowed: false; governance: HiveMemoryGovernanceState }> {
  const governance = await getHiveMemoryGovernanceState(db, input.hiveId);
  if (governance.memoryEnabled) {
    return { allowed: true, governance };
  }

  await recordMemoryBlockedOperation(db, {
    hiveId: input.hiveId,
    source: input.source,
    operation: input.operation ?? "write",
    reason: governance.reason,
  });

  return {
    allowed: false,
    governance: {
      ...governance,
      lastBlockedAt: new Date().toISOString(),
      lastBlockedOperation: input.operation ?? "write",
      lastBlockedSource: input.source,
      blocked: true,
      statusLabels: buildStatusLabels({
        memoryEnabled: governance.memoryEnabled,
        blocked: true,
        recentlyUsed: governance.recentlyUsed,
      }),
    },
  };
}

export async function setHiveMemoryGovernanceState(
  db: Sql,
  input: {
    hiveId: string;
    enabled: boolean;
    reason?: string | null;
    changedBy?: string | null;
  },
): Promise<HiveMemoryGovernanceSummary> {
  await db`
    INSERT INTO hive_memory_governance (
      hive_id,
      memory_disabled,
      reason,
      changed_by,
      updated_at
    )
    VALUES (
      ${input.hiveId},
      ${!input.enabled},
      ${input.enabled ? null : input.reason ?? null},
      ${input.changedBy ?? null},
      NOW()
    )
    ON CONFLICT (hive_id)
    DO UPDATE SET
      memory_disabled = EXCLUDED.memory_disabled,
      reason = EXCLUDED.reason,
      changed_by = EXCLUDED.changed_by,
      updated_at = NOW()
  `;

  return getHiveMemoryGovernanceSummary(db, input.hiveId);
}

export async function getHiveMemoryGovernanceSummary(
  db: QuerySql,
  hiveId: string,
): Promise<HiveMemoryGovernanceSummary> {
  const governance = await getHiveMemoryGovernanceState(db, hiveId);
  const [counts] = await db<{
    role_memory: number;
    hive_memory: number;
    deleted_role_memory: number;
    deleted_hive_memory: number;
  }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM role_memory WHERE hive_id = ${hiveId} AND superseded_by IS NULL) AS role_memory,
      (SELECT COUNT(*)::int FROM hive_memory WHERE hive_id = ${hiveId} AND superseded_by IS NULL) AS hive_memory,
      (SELECT COUNT(*)::int FROM role_memory WHERE hive_id = ${hiveId} AND superseded_by IS NOT NULL) AS deleted_role_memory,
      (SELECT COUNT(*)::int FROM hive_memory WHERE hive_id = ${hiveId} AND superseded_by IS NOT NULL) AS deleted_hive_memory
  `;

  return {
    hiveId: governance.hiveId,
    memoryEnabled: governance.memoryEnabled,
    reason: governance.reason,
    changedBy: governance.changedBy,
    updatedAt: governance.updatedAt,
    status: {
      enabled: governance.memoryEnabled,
      disabled: !governance.memoryEnabled,
      blocked: governance.blocked,
      recentlyUsed: governance.recentlyUsed,
      labels: governance.statusLabels,
    },
    activity: {
      lastUsedAt: governance.lastUsedAt,
      lastWriteAt: governance.lastWriteAt,
      lastBlockedAt: governance.lastBlockedAt,
      lastBlockedOperation: governance.lastBlockedOperation,
      lastBlockedSource: governance.lastBlockedSource,
    },
    counts: {
      roleMemory: counts?.role_memory ?? 0,
      hiveMemory: counts?.hive_memory ?? 0,
      deletedRoleMemory: counts?.deleted_role_memory ?? 0,
      deletedHiveMemory: counts?.deleted_hive_memory ?? 0,
    },
    scopeLabel: MEMORY_SCOPE_LABEL,
  };
}

export function memoryGovernanceDisabledResponse(
  governance: HiveMemoryGovernanceState,
): NextResponse {
  const suffix = governance.reason ? `: ${governance.reason}` : "";
  const statusLabels = governance.statusLabels ?? ["disabled"];
  return NextResponse.json({
    error: `${MEMORY_DISABLED_ERROR}${suffix}`,
    code: "HIVE_MEMORY_DISABLED",
    memoryGovernance: {
      hiveId: governance.hiveId,
      memoryEnabled: governance.memoryEnabled,
      reason: governance.reason,
      changedBy: governance.changedBy,
      updatedAt: governance.updatedAt,
      status: {
        enabled: governance.memoryEnabled,
        disabled: !governance.memoryEnabled,
        blocked: governance.blocked ?? true,
        recentlyUsed: governance.recentlyUsed ?? false,
        labels: statusLabels,
      },
      activity: {
        lastUsedAt: governance.lastUsedAt ?? null,
        lastWriteAt: governance.lastWriteAt ?? null,
        lastBlockedAt: governance.lastBlockedAt ?? null,
        lastBlockedOperation: governance.lastBlockedOperation ?? null,
        lastBlockedSource: governance.lastBlockedSource ?? null,
      },
      scopeLabel: MEMORY_SCOPE_LABEL,
    },
  }, { status: 423 });
}

export async function getMemoryEntryScope(
  db: QuerySql,
  input: { id: string; store: "role_memory" | "hive_memory" },
): Promise<MemoryEntryScope | null> {
  const rows = input.store === "role_memory"
    ? await db<{ id: string; hive_id: string }[]>`
        SELECT id, hive_id
        FROM role_memory
        WHERE id = ${input.id}::uuid
        LIMIT 1
      `
    : await db<{ id: string; hive_id: string }[]>`
        SELECT id, hive_id
        FROM hive_memory
        WHERE id = ${input.id}::uuid
        LIMIT 1
      `;

  const row = rows[0];
  return row ? { id: row.id, hiveId: row.hive_id, store: input.store } : null;
}

export async function softDeleteMemoryEntry(
  db: QuerySql,
  input: { id: string; store: "role_memory" | "hive_memory" },
): Promise<SoftDeleteMemoryEntryResult | null> {
  const rows = input.store === "role_memory"
    ? await db<{ id: string; hive_id: string; updated_at: Date }[]>`
        UPDATE role_memory
        SET superseded_by = COALESCE(superseded_by, ${DELETED_SENTINEL}::uuid),
            updated_at = NOW()
        WHERE id = ${input.id}::uuid
        RETURNING id, hive_id, updated_at
      `
    : await db<{ id: string; hive_id: string; updated_at: Date }[]>`
        UPDATE hive_memory
        SET superseded_by = COALESCE(superseded_by, ${DELETED_SENTINEL}::uuid),
            updated_at = NOW()
        WHERE id = ${input.id}::uuid
        RETURNING id, hive_id, updated_at
      `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    hiveId: row.hive_id,
    store: input.store,
    status: "soft_deleted",
    deletedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}
