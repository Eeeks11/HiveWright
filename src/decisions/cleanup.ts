import type { Sql } from "postgres";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEvent,
} from "@/audit/agent-events";
import {
  INTERNAL_DECISION_REASON_SQL,
  INTERNAL_DECISION_SQL,
} from "@/decisions/visibility";

export interface ArchiveStaleInternalDecisionsOptions {
  now?: Date;
  olderThanDays?: number;
  hiveId?: string;
  goalId?: string;
  limit?: number;
}

export interface ArchiveStaleInternalDecisionsResult {
  archivedCount: number;
  archivedDecisionIds: string[];
  cutoff: Date;
}

export interface ReconcileDecisionIntegrityOptions extends ArchiveStaleInternalDecisionsOptions {
  goalId?: string;
}

export interface DecisionIntegrityOperatorAction {
  decisionId: string;
  reason: string;
  priority: string;
}

export interface ReconcileDecisionIntegrityResult {
  archivedCount: number;
  archivedDecisionIds: string[];
  resolvedCount: number;
  resolvedDecisionIds: string[];
  operatorActions: DecisionIntegrityOperatorAction[];
  cutoff: Date;
}

interface ArchivedDecisionRow {
  id: string;
  hive_id: string | null;
  goal_id: string | null;
  task_id: string | null;
  internal_reason: string | null;
}

interface UnsafeContradictionRow {
  id: string;
  priority: string;
  integrity_reason: string;
}

function cutoffDate(now: Date, olderThanDays: number): Date {
  return new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
}

async function recordDecisionCleanupAudit(
  sql: Sql,
  input: {
    targetId?: string | null;
    hiveId?: string | null;
    goalId?: string | null;
    archivedDecisionIds: string[];
    resolvedDecisionIds?: string[];
    cutoff: Date;
    olderThanDays: number;
    limit: number;
    reasons?: Array<{ decisionId: string; reason: string | null }>;
    operatorActions?: DecisionIntegrityOperatorAction[];
    source: string;
  },
): Promise<void> {
  await recordAgentAuditEvent(sql, {
    eventType: AGENT_AUDIT_EVENTS.decisionArchived,
    actor: { type: "system", id: "decision-cleanup", label: "decision-cleanup" },
    hiveId: input.hiveId ?? null,
    goalId: input.goalId ?? null,
    targetType: "decision_cleanup",
    targetId: input.targetId ?? null,
    outcome: "success",
    metadata: {
      source: input.source,
      archivedCount: input.archivedDecisionIds.length,
      archivedDecisionIds: input.archivedDecisionIds,
      resolvedCount: input.resolvedDecisionIds?.length ?? 0,
      resolvedDecisionIds: input.resolvedDecisionIds ?? [],
      cutoff: input.cutoff.toISOString(),
      olderThanDays: input.olderThanDays,
      limit: input.limit,
      hiveId: input.hiveId ?? null,
      goalId: input.goalId ?? null,
      reasons: input.reasons ?? [],
      operatorActions: input.operatorActions ?? [],
    },
  });
}

export async function archiveStaleInternalDecisions(
  sql: Sql,
  options: ArchiveStaleInternalDecisionsOptions = {},
): Promise<ArchiveStaleInternalDecisionsResult> {
  const now = options.now ?? new Date();
  const olderThanDays = options.olderThanDays ?? 14;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const cutoff = cutoffDate(now, olderThanDays);
  const goalFilter = options.goalId ?? null;

  const rows = await sql<ArchivedDecisionRow[]>`
    WITH candidates AS (
      SELECT
        d.id,
        d.hive_id,
        d.goal_id,
        d.task_id,
        ${sql.unsafe(INTERNAL_DECISION_REASON_SQL)} AS internal_reason
      FROM decisions d
      JOIN hives h ON h.id = d.hive_id
      LEFT JOIN tasks t ON t.id = d.task_id AND t.hive_id = d.hive_id
      WHERE d.status IN ('pending', 'ea_review')
        AND d.priority IN ('low', 'normal')
        AND d.created_at < ${cutoff}
        AND (${options.hiveId ?? null}::uuid IS NULL OR d.hive_id = ${options.hiveId ?? null}::uuid)
        AND (${goalFilter}::uuid IS NULL OR d.goal_id = ${goalFilter}::uuid)
        AND ${sql.unsafe(INTERNAL_DECISION_SQL)}
      ORDER BY d.created_at ASC
      LIMIT ${limit}
    ),
    archived AS (
      UPDATE decisions d
      SET status = 'archived',
          resolved_by = 'decision-cleanup',
          resolved_at = COALESCE(d.resolved_at, ${now}),
          owner_response = COALESCE(d.owner_response, 'archived: stale internal/system decision cleanup')
      FROM candidates c
      WHERE d.id = c.id
      RETURNING d.id, d.hive_id, d.goal_id, d.task_id, c.internal_reason
    )
    SELECT id, hive_id, goal_id, task_id, internal_reason
    FROM archived
  `;

  const archivedDecisionIds = rows.map((row) => row.id);

  await recordDecisionCleanupAudit(sql, {
    targetId: options.goalId ?? options.hiveId ?? null,
    hiveId: options.hiveId ?? null,
    goalId: options.goalId ?? null,
    archivedDecisionIds,
    cutoff,
    olderThanDays,
    limit,
    reasons: rows.map((row) => ({
      decisionId: row.id,
      reason: row.internal_reason,
    })),
    source: "stale_internal_decision_cleanup",
  });

  return {
    archivedCount: archivedDecisionIds.length,
    archivedDecisionIds,
    cutoff,
  };
}

export async function reconcileDecisionIntegrity(
  sql: Sql,
  options: ReconcileDecisionIntegrityOptions = {},
): Promise<ReconcileDecisionIntegrityResult> {
  const now = options.now ?? new Date();
  const olderThanDays = options.olderThanDays ?? 14;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const cutoff = cutoffDate(now, olderThanDays);
  const hiveFilter = options.hiveId ?? null;
  const goalFilter = options.goalId ?? null;

  const staleInternal = await archiveStaleInternalDecisions(sql, {
    now,
    olderThanDays,
    hiveId: options.hiveId,
    goalId: options.goalId,
    limit,
  });

  const rows = await sql<ArchivedDecisionRow[]>`
    WITH candidates AS (
      SELECT
        d.id,
        d.hive_id,
        d.goal_id,
        d.task_id,
        CASE
          WHEN d.resolved_at IS NOT NULL THEN 'pending_with_resolved_at'
          WHEN NULLIF(BTRIM(COALESCE(d.owner_response, '')), '') IS NOT NULL THEN 'pending_with_owner_response'
          WHEN COALESCE(d.route_metadata #>> '{ownerActionRequired}', 'true') = 'false' THEN 'route_owner_action_not_required'
          WHEN COALESCE(d.options #>> '{ownerActionRequired}', 'true') = 'false' THEN 'option_owner_action_not_required'
          ELSE ${sql.unsafe(INTERNAL_DECISION_REASON_SQL)}
        END AS internal_reason
      FROM decisions d
      JOIN hives h ON h.id = d.hive_id
      LEFT JOIN tasks t ON t.id = d.task_id AND t.hive_id = d.hive_id
      WHERE d.status = 'pending'
        AND (${hiveFilter}::uuid IS NULL OR d.hive_id = ${hiveFilter}::uuid)
        AND (${goalFilter}::uuid IS NULL OR d.goal_id = ${goalFilter}::uuid)
        AND (
          d.resolved_at IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(d.owner_response, '')), '') IS NOT NULL
          OR COALESCE(d.route_metadata #>> '{ownerActionRequired}', 'true') = 'false'
          OR COALESCE(d.options #>> '{ownerActionRequired}', 'true') = 'false'
        )
        AND d.priority IN ('low', 'normal')
      ORDER BY d.created_at ASC
      LIMIT ${limit}
    ),
    reconciled AS (
      UPDATE decisions d
      SET status = CASE
            WHEN c.internal_reason IN ('pending_with_resolved_at', 'pending_with_owner_response') THEN 'resolved'
            ELSE 'archived'
          END,
          resolved_by = COALESCE(d.resolved_by, 'decision-integrity-sweeper'),
          resolved_at = COALESCE(d.resolved_at, ${now}),
          owner_response = COALESCE(d.owner_response, CASE
            WHEN c.internal_reason IN ('pending_with_resolved_at', 'pending_with_owner_response')
              THEN 'resolved: stale pending decision integrity reconciliation'
            ELSE 'archived: non-owner-action-required decision integrity reconciliation'
          END)
      FROM candidates c
      WHERE d.id = c.id
      RETURNING d.id, d.hive_id, d.goal_id, d.task_id, d.status, c.internal_reason
    )
    SELECT id, hive_id, goal_id, task_id, internal_reason
    FROM reconciled
  `;

  const resolvedDecisionIds = rows
    .filter((row) => row.internal_reason === "pending_with_resolved_at" || row.internal_reason === "pending_with_owner_response")
    .map((row) => row.id);
  const archivedDecisionIds = [
    ...staleInternal.archivedDecisionIds,
    ...rows
      .filter((row) => row.internal_reason !== "pending_with_resolved_at" && row.internal_reason !== "pending_with_owner_response")
      .map((row) => row.id),
  ];

  const unsafeRows = await sql<UnsafeContradictionRow[]>`
    SELECT
      d.id,
      d.priority,
      CASE
        WHEN COALESCE(d.route_metadata #>> '{ownerActionRequired}', 'true') = 'false' THEN 'route_owner_action_not_required_high_priority'
        WHEN COALESCE(d.options #>> '{ownerActionRequired}', 'true') = 'false' THEN 'option_owner_action_not_required_high_priority'
        WHEN ${sql.unsafe(INTERNAL_DECISION_SQL)} THEN COALESCE(${sql.unsafe(INTERNAL_DECISION_REASON_SQL)}, 'internal_system_high_priority')
        ELSE 'pending_decision_needs_operator_review'
      END AS integrity_reason
    FROM decisions d
    JOIN hives h ON h.id = d.hive_id
    LEFT JOIN tasks t ON t.id = d.task_id AND t.hive_id = d.hive_id
    WHERE d.status = 'pending'
      AND d.priority NOT IN ('low', 'normal')
      AND (${hiveFilter}::uuid IS NULL OR d.hive_id = ${hiveFilter}::uuid)
      AND (${goalFilter}::uuid IS NULL OR d.goal_id = ${goalFilter}::uuid)
      AND (
        COALESCE(d.route_metadata #>> '{ownerActionRequired}', 'true') = 'false'
        OR COALESCE(d.options #>> '{ownerActionRequired}', 'true') = 'false'
        OR ${sql.unsafe(INTERNAL_DECISION_SQL)}
      )
    ORDER BY d.created_at ASC
    LIMIT 20
  `;
  const operatorActions = unsafeRows.map((row) => ({
    decisionId: row.id,
    reason: row.integrity_reason,
    priority: row.priority,
  }));

  if (rows.length > 0 || operatorActions.length > 0) {
    await recordDecisionCleanupAudit(sql, {
      targetId: options.goalId ?? options.hiveId ?? null,
      hiveId: options.hiveId ?? null,
      goalId: options.goalId ?? null,
      archivedDecisionIds: rows
        .filter((row) => row.internal_reason !== "pending_with_resolved_at" && row.internal_reason !== "pending_with_owner_response")
        .map((row) => row.id),
      resolvedDecisionIds,
      cutoff,
      olderThanDays,
      limit,
      reasons: rows.map((row) => ({
        decisionId: row.id,
        reason: row.internal_reason,
      })),
      operatorActions,
      source: "decision_integrity_reconciliation",
    });
  }

  return {
    archivedCount: archivedDecisionIds.length,
    archivedDecisionIds,
    resolvedCount: resolvedDecisionIds.length,
    resolvedDecisionIds,
    operatorActions,
    cutoff,
  };
}
