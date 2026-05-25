import type { Sql } from "postgres";
import {
  getHiveResumeReadiness,
  type HiveResumeReadiness,
  type ModelReadinessChecker,
} from "@/hives/resume-readiness";

export type OperatorVerdictStatus = "ready" | "running" | "blocked" | "degraded";
export type OperatorBlockerSeverity = "info" | "warning" | "critical";

export interface OperatorVerdictBlocker {
  code: string;
  severity: OperatorBlockerSeverity;
  label: string;
  detail: string;
  count?: number;
}

export interface HiveOperatorVerdict {
  status: OperatorVerdictStatus;
  canRunNow: boolean;
  summary: string;
  checkedAt: string;
  blockers: OperatorVerdictBlocker[];
  signals: {
    schedules: {
      enabled: number;
    };
    runnableTasks: number;
    pendingDecisions: number;
    modelHealth: {
      enabled: number;
      ready: number;
      blocked: number;
      stale: number;
      unavailable: number;
      onDemand: number;
    };
    budgetBlocks: number;
    stuckActiveTasks: number;
    deliverables: {
      total: number;
      ownerAccessible: number;
      lastCompletedAt: string | null;
      lastOpenUrl: string | null;
    };
    lastSuccessfulGoalCompletion: {
      completedAt: string | null;
      evidenceReferencesDeliverable: boolean;
    };
    recovery: {
      interruptedActiveRecovered: number;
      executionRunsInterruptedRecovered: number;
      lastRecoveryAt: string | null;
      hasRecoveryEvidence: boolean;
    };
    executionRuns: {
      running: number;
      recentFailed: number;
      latestStatus: string | null;
      latestLivenessState: string | null;
      latestLivenessReason: string | null;
    };
    resumeReadiness: Pick<HiveResumeReadiness, "status" | "canResumeSafely" | "counts" | "sessions">;
  };
}

interface OpsSignalsRow {
  budget_blocks: string | number;
  stuck_active_tasks: string | number;
  deliverables_total: string | number;
  owner_accessible_deliverables: string | number;
  last_deliverable_completed_at: Date | string | null;
  last_open_url: string | null;
  last_goal_completed_at: Date | string | null;
  last_completion_evidence_references_deliverable: boolean | null;
  interrupted_active_recovered: string | number;
  execution_runs_running: string | number;
  execution_runs_interrupted_recovered: string | number;
  execution_runs_recent_failed: string | number;
  latest_execution_run_status: string | null;
  latest_execution_run_liveness_state: string | null;
  latest_execution_run_liveness_reason: string | null;
  last_recovery_at: Date | string | null;
}

export async function getHiveOperatorVerdict(
  sql: Sql,
  input: {
    hiveId: string;
    now?: Date;
    checkModelHealth?: ModelReadinessChecker;
  },
): Promise<HiveOperatorVerdict> {
  const now = input.now ?? new Date();
  const readiness = await getHiveResumeReadiness(sql, {
    hiveId: input.hiveId,
    now,
    checkModelHealth: input.checkModelHealth,
  });
  const [opsRow] = await sql<OpsSignalsRow[]>`
    WITH latest_completion AS (
      SELECT
        gc.created_at,
        gc.evidence,
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(gc.evidence->'bundle', '[]'::jsonb)) AS bundle_item
          WHERE COALESCE(bundle_item->>'reference', bundle_item->>'value', '') LIKE '/api/work-products/%'
             OR COALESCE(bundle_item->>'reference', bundle_item->>'value', '') LIKE '/deliverables/%'
        )
        OR jsonb_array_length(COALESCE(gc.evidence->'workProductIds', '[]'::jsonb)) > 0
          AS evidence_references_deliverable
      FROM goal_completions gc
      JOIN goals g ON g.id = gc.goal_id
      WHERE g.hive_id = ${input.hiveId}::uuid
      ORDER BY gc.created_at DESC NULLS LAST
      LIMIT 1
    ), owner_openable_deliverables AS (
      SELECT
        wp.published_at,
        CASE
          WHEN wp.public_url IS NOT NULL
            AND wp.public_url <> ''
            AND (
              wp.public_url LIKE 'http://%'
              OR wp.public_url LIKE 'https://%'
              OR wp.public_url LIKE '/api/work-products/%'
              OR wp.public_url LIKE '/deliverables/%'
            )
            THEN wp.public_url
          WHEN wp.file_path IS NOT NULL
            AND wp.file_path <> ''
            AND COALESCE(wp.artifact_kind, '') IN ('final_artifact', 'html', 'image', 'external_url')
            AND COALESCE(wp.render_mode, '') IN ('html', 'image', 'markdown', 'pdf', 'text')
            THEN '/deliverables/' || wp.id::text || '/open'
          ELSE NULL
        END AS open_url
      FROM work_products wp
      WHERE wp.hive_id = ${input.hiveId}::uuid
    ), latest_deliverable AS (
      SELECT published_at, open_url
      FROM owner_openable_deliverables
      WHERE open_url IS NOT NULL
      ORDER BY published_at DESC NULLS LAST
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM goals
        WHERE hive_id = ${input.hiveId}::uuid
          AND (budget_state IN ('blocked', 'enforced') OR budget_enforced_at IS NOT NULL))::int AS budget_blocks,
      (SELECT COUNT(*) FROM tasks
        WHERE hive_id = ${input.hiveId}::uuid
          AND status = 'active'
          AND (
            (last_heartbeat IS NOT NULL AND last_heartbeat < ${now} - INTERVAL '15 minutes')
            OR (last_heartbeat IS NULL AND started_at < ${now} - INTERVAL '15 minutes')
          ))::int AS stuck_active_tasks,
      (SELECT COUNT(*) FROM work_products WHERE hive_id = ${input.hiveId}::uuid)::int AS deliverables_total,
      (SELECT COUNT(*) FROM owner_openable_deliverables WHERE open_url IS NOT NULL)::int AS owner_accessible_deliverables,
      (SELECT published_at FROM latest_deliverable WHERE open_url IS NOT NULL) AS last_deliverable_completed_at,
      (SELECT open_url FROM latest_deliverable WHERE open_url IS NOT NULL) AS last_open_url,
      (SELECT created_at FROM latest_completion) AS last_goal_completed_at,
      (SELECT evidence_references_deliverable FROM latest_completion) AS last_completion_evidence_references_deliverable,
      (SELECT COUNT(*) FROM tasks
        WHERE hive_id = ${input.hiveId}::uuid
          AND failure_reason ILIKE 'Interrupted by dispatcher lifecycle recovery:%')::int AS interrupted_active_recovered,
      (SELECT COUNT(*) FROM execution_runs WHERE hive_id = ${input.hiveId}::uuid AND status = 'running')::int AS execution_runs_running,
      (SELECT COUNT(*) FROM execution_runs WHERE hive_id = ${input.hiveId}::uuid AND status = 'interrupted' AND liveness_state = 'recovered')::int AS execution_runs_interrupted_recovered,
      (SELECT COUNT(*) FROM execution_runs
        WHERE hive_id = ${input.hiveId}::uuid
          AND status = 'failed'
          AND finished_at >= ${now} - INTERVAL '24 hours')::int AS execution_runs_recent_failed,
      (SELECT status FROM execution_runs WHERE hive_id = ${input.hiveId}::uuid ORDER BY started_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 1) AS latest_execution_run_status,
      (SELECT liveness_state FROM execution_runs WHERE hive_id = ${input.hiveId}::uuid ORDER BY started_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 1) AS latest_execution_run_liveness_state,
      (SELECT liveness_reason FROM execution_runs WHERE hive_id = ${input.hiveId}::uuid ORDER BY started_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 1) AS latest_execution_run_liveness_reason,
      GREATEST(
        (SELECT MAX(updated_at) FROM tasks
          WHERE hive_id = ${input.hiveId}::uuid
            AND failure_reason ILIKE 'Interrupted by dispatcher lifecycle recovery:%'),
        (SELECT MAX(updated_at) FROM execution_runs
          WHERE hive_id = ${input.hiveId}::uuid
            AND status = 'interrupted'
            AND liveness_state = 'recovered')
      ) AS last_recovery_at
  `;

  const signals = {
    schedules: {
      enabled: readiness.counts.enabledSchedules,
    },
    runnableTasks: readiness.counts.runnableTasks,
    pendingDecisions: readiness.counts.pendingDecisions,
    modelHealth: {
      enabled: readiness.models.enabled,
      ready: readiness.models.ready,
      blocked: readiness.models.blocked,
      stale: readiness.models.stale,
      unavailable: readiness.models.unavailable,
      onDemand: readiness.models.onDemand,
    },
    budgetBlocks: toCount(opsRow?.budget_blocks),
    stuckActiveTasks: toCount(opsRow?.stuck_active_tasks),
    deliverables: {
      total: toCount(opsRow?.deliverables_total),
      ownerAccessible: toCount(opsRow?.owner_accessible_deliverables),
      lastCompletedAt: toIsoOrNull(opsRow?.last_deliverable_completed_at),
      lastOpenUrl: sanitizeOpenUrl(opsRow?.last_open_url ?? null),
    },
    lastSuccessfulGoalCompletion: {
      completedAt: toIsoOrNull(opsRow?.last_goal_completed_at),
      evidenceReferencesDeliverable: Boolean(opsRow?.last_completion_evidence_references_deliverable),
    },
    recovery: {
      interruptedActiveRecovered: toCount(opsRow?.interrupted_active_recovered),
      executionRunsInterruptedRecovered: toCount(opsRow?.execution_runs_interrupted_recovered),
      lastRecoveryAt: toIsoOrNull(opsRow?.last_recovery_at),
      hasRecoveryEvidence: toCount(opsRow?.interrupted_active_recovered) > 0
        || toCount(opsRow?.execution_runs_interrupted_recovered) > 0,
    },
    executionRuns: {
      running: toCount(opsRow?.execution_runs_running),
      recentFailed: toCount(opsRow?.execution_runs_recent_failed),
      latestStatus: opsRow?.latest_execution_run_status ?? null,
      latestLivenessState: opsRow?.latest_execution_run_liveness_state ?? null,
      latestLivenessReason: opsRow?.latest_execution_run_liveness_reason ?? null,
    },
    resumeReadiness: {
      status: readiness.status,
      canResumeSafely: readiness.canResumeSafely,
      counts: readiness.counts,
      sessions: readiness.sessions,
    },
  };

  const blockers = buildOperatorBlockers(readiness, signals);
  const criticalBlockers = blockers.filter((blocker) => blocker.severity === "critical");
  const canRunNow = criticalBlockers.length === 0 && readiness.models.ready > 0 && signals.budgetBlocks === 0;
  const status = classifyVerdictStatus(readiness.status, canRunNow, blockers);

  return {
    status,
    canRunNow,
    summary: summarizeVerdict(status, blockers, signals),
    checkedAt: now.toISOString(),
    blockers,
    signals,
  };
}

function buildOperatorBlockers(
  readiness: HiveResumeReadiness,
  signals: HiveOperatorVerdict["signals"],
): OperatorVerdictBlocker[] {
  const blockers: OperatorVerdictBlocker[] = readiness.blockers.map((blocker) => ({
    code: `resume_${blocker.code}`,
    severity: blocker.code === "model_health_blocked" || blocker.code === "no_enabled_models" ? "critical" : "warning",
    label: blocker.label,
    detail: blocker.detail,
    count: blocker.count,
  }));

  if (signals.budgetBlocks > 0) {
    blockers.push({
      code: "budget_blocked",
      severity: "critical",
      label: "Budget enforcement is blocking work",
      detail: "One or more goals have enforced/blocked budget state. Review budget controls before dispatching more work.",
      count: signals.budgetBlocks,
    });
  }
  if (signals.stuckActiveTasks > 0) {
    blockers.push({
      code: "stuck_active_tasks",
      severity: "critical",
      label: "Active tasks appear stuck",
      detail: "One or more active tasks have stale or missing heartbeats beyond the restart/watchdog threshold.",
      count: signals.stuckActiveTasks,
    });
  }
  if (signals.executionRuns.recentFailed > 0) {
    blockers.push({
      code: "recent_execution_run_failures",
      severity: "warning",
      label: "Recent execution runs failed",
      detail: "One or more adapter execution runs failed in the last 24 hours. Review execution run events before relying on unattended operation.",
      count: signals.executionRuns.recentFailed,
    });
  }
  if (readiness.models.enabled === 0 || readiness.models.ready === 0) {
    blockers.push({
      code: "no_ready_model_route",
      severity: "critical",
      label: "No ready model route",
      detail: "The dispatcher needs at least one enabled model route with runnable health evidence.",
      count: readiness.models.enabled,
    });
  }
  if (signals.deliverables.total > 0 && signals.deliverables.ownerAccessible === 0) {
    blockers.push({
      code: "deliverables_not_owner_accessible",
      severity: "warning",
      label: "Deliverables are not owner-openable",
      detail: "Work products exist, but none expose a public/source URL for owner handoff.",
      count: signals.deliverables.total,
    });
  }
  return blockers;
}

function classifyVerdictStatus(
  readinessStatus: HiveResumeReadiness["status"],
  canRunNow: boolean,
  blockers: OperatorVerdictBlocker[],
): OperatorVerdictStatus {
  if (readinessStatus === "running" && canRunNow) return "running";
  if (blockers.some((blocker) => blocker.severity === "critical")) return "blocked";
  if (canRunNow && blockers.length === 0) return "ready";
  return canRunNow ? "degraded" : "blocked";
}

function summarizeVerdict(
  status: OperatorVerdictStatus,
  blockers: OperatorVerdictBlocker[],
  signals: HiveOperatorVerdict["signals"],
): string {
  if (status === "blocked") {
    const first = blockers.find((blocker) => blocker.severity === "critical") ?? blockers[0];
    return first ? `Hive cannot run safely now: ${first.label}.` : "Hive cannot run safely now.";
  }
  if (status === "degraded") {
    return "Hive can run, but operator warnings should be reviewed before relying on unattended operation.";
  }
  if (status === "running") {
    return `Hive is running with ${signals.runnableTasks} runnable/open task(s) and ${signals.modelHealth.ready} ready model route(s).`;
  }
  return `Hive is ready to run with ${signals.modelHealth.ready} ready model route(s), ${signals.pendingDecisions} pending decision(s), and ${signals.budgetBlocks} budget block(s).`;
}

function toCount(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeOpenUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith("/api/work-products/") || value.startsWith("/deliverables/")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return value;
  } catch {
    return null;
  }
  return null;
}
