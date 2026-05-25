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
  limit?: number;
}

export interface ArchiveStaleInternalDecisionsResult {
  archivedCount: number;
  archivedDecisionIds: string[];
  cutoff: Date;
}

interface ArchivedDecisionRow {
  id: string;
  hive_id: string | null;
  goal_id: string | null;
  task_id: string | null;
  internal_reason: string | null;
}

function cutoffDate(now: Date, olderThanDays: number): Date {
  return new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
}

export async function archiveStaleInternalDecisions(
  sql: Sql,
  options: ArchiveStaleInternalDecisionsOptions = {},
): Promise<ArchiveStaleInternalDecisionsResult> {
  const now = options.now ?? new Date();
  const olderThanDays = options.olderThanDays ?? 14;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const cutoff = cutoffDate(now, olderThanDays);

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

  await recordAgentAuditEvent(sql, {
    eventType: AGENT_AUDIT_EVENTS.decisionArchived,
    actor: { type: "system", id: "decision-cleanup", label: "decision-cleanup" },
    targetType: "decision_cleanup",
    targetId: options.hiveId ?? null,
    outcome: "success",
    metadata: {
      archivedCount: archivedDecisionIds.length,
      archivedDecisionIds,
      cutoff: cutoff.toISOString(),
      olderThanDays,
      limit,
      hiveId: options.hiveId ?? null,
      reasons: rows.map((row) => ({
        decisionId: row.id,
        reason: row.internal_reason,
      })),
    },
  });

  return {
    archivedCount: archivedDecisionIds.length,
    archivedDecisionIds,
    cutoff,
  };
}
