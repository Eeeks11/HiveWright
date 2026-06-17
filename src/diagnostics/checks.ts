import fs from "node:fs";
import path from "node:path";
import type { Sql } from "postgres";
import { sql as apiSql } from "@/app/api/_lib/db";
import { getBundledMigrationFiles, getExpectedLatestMigration } from "@/db/migration-metadata";
import { loadDispatcherHeartbeatStatus } from "@/dispatcher/heartbeat";
import { canonicalModelIdForAdapter } from "@/model-health/model-identity";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { getModelHealthProbePolicy } from "@/model-health/probe-policy";
import {
  buildFailureFingerprint,
  groupFailureFingerprints,
  type FailureFingerprintGroup,
} from "./error-fingerprints";
import {
  buildDiagnosticStatus,
  summarizeDiagnostics,
  type DiagnosticStatus,
  type DiagnosticSummary,
} from "./types";
import { resolveHiveWrightBuildProvenance } from "./build-provenance";

export type HiveWrightDiagnosticsSnapshot = {
  checkedAt: string;
  summary: DiagnosticSummary;
  diagnostics: DiagnosticStatus[];
  recentFailureGroups: FailureFingerprintGroup[];
};

export type HiveWrightHealthSnapshot = {
  status: "ok";
  service: "hivewright";
  version: string | null;
  buildHash: string | null;
  checkedAt: string;
};

export type HiveWrightDiagnosticsOptions = {
  sql?: Sql;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  repoRoot?: string;
};

const REQUIRED_ENV = ["DATABASE_URL", "ENCRYPTION_KEY", "INTERNAL_SERVICE_TOKEN"] as const;
const DISPATCHER_STALE_AFTER_MS = 2 * 60 * 1000;
const EXECUTION_RUN_STALE_AFTER_MS = 15 * 60 * 1000;

export function getHiveWrightHealthSnapshot(input: { env?: NodeJS.ProcessEnv; now?: Date; repoRoot?: string } = {}): HiveWrightHealthSnapshot {
  const provenance = resolveHiveWrightBuildProvenance({
    env: input.env,
    now: input.now,
    repoRoot: input.repoRoot,
  });
  return {
    status: "ok",
    service: "hivewright",
    version: provenance.version,
    buildHash: provenance.buildHash,
    checkedAt: provenance.capturedAt,
  };
}

export async function collectHiveWrightDiagnostics(
  input: HiveWrightDiagnosticsOptions = {},
): Promise<HiveWrightDiagnosticsSnapshot> {
  const sql = input.sql ?? apiSql;
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const repoRoot = input.repoRoot ?? process.cwd();
  const checkedAt = now.toISOString();
  const diagnostics: DiagnosticStatus[] = [];

  diagnostics.push(checkRuntimeConfig(env, now));
  diagnostics.push(checkWorkspace(repoRoot, now));
  diagnostics.push(await checkDatabase(sql, now));
  diagnostics.push(await checkMigrationState(sql, repoRoot, now));
  diagnostics.push(await checkDispatcherHeartbeat(sql, now));
  diagnostics.push(await checkQueueState(sql, now));
  diagnostics.push(await checkExecutionRuns(sql, now));
  diagnostics.push(await checkProviderState(sql, now));
  diagnostics.push(await checkModelRoutePoolCapacity(sql, now));

  const recentFailureGroups = await collectRecentFailureGroups(sql);
  if (recentFailureGroups.length > 0) {
    const repeated = recentFailureGroups.filter((group) => group.count >= 2);
    diagnostics.push(buildDiagnosticStatus({
      id: "runtime.repeated_failures",
      label: "Repeated failure fingerprints",
      severity: repeated.length > 0 ? "warning" : "info",
      summary: repeated.length > 0
        ? `${repeated.length} repeated failure signature(s) seen in recent execution runs.`
        : `${recentFailureGroups.length} recent failure signature(s) available for review.`,
      affectedHiveIds: unique(recentFailureGroups.flatMap((group) => group.affectedHiveIds)),
      affectedGoalIds: unique(recentFailureGroups.flatMap((group) => group.affectedGoalIds)),
      affectedTaskIds: unique(recentFailureGroups.flatMap((group) => group.affectedTaskIds)),
      recommendedAction: repeated.length > 0
        ? "Review the repeated signatures before allowing retries to continue."
        : "No repeated failure storm detected.",
      checkedAt: now,
    }));
  }

  return {
    checkedAt,
    summary: summarizeDiagnostics(diagnostics),
    diagnostics,
    recentFailureGroups,
  };
}

function checkRuntimeConfig(env: NodeJS.ProcessEnv, now: Date): DiagnosticStatus {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  return buildDiagnosticStatus({
    id: "app.runtime_config",
    label: "Runtime configuration",
    severity: missing.length > 0 ? "critical" : "ok",
    summary: missing.length > 0
      ? `Missing required runtime config: ${missing.join(", ")}.`
      : "Required runtime configuration is present.",
    details: missing.length > 0 ? "Required values are checked by name only; values are not exposed." : undefined,
    recommendedAction: missing.length > 0
      ? "Set the missing environment variables and restart HiveWright."
      : undefined,
    requiresOwnerAction: missing.length > 0,
    checkedAt: now,
  });
}

export function checkWorkspace(repoRoot: string, now: Date): DiagnosticStatus {
  try {
    fs.accessSync(repoRoot, fs.constants.R_OK | fs.constants.X_OK);
    return buildDiagnosticStatus({
      id: "app.workspace",
      label: "Application workspace",
      severity: "ok",
      summary: "Application workspace is readable and executable.",
      details: path.resolve(repoRoot),
      checkedAt: now,
    });
  } catch (err) {
    return buildDiagnosticStatus({
      id: "app.workspace",
      label: "Application workspace",
      severity: "critical",
      summary: "Application workspace is not readable/executable.",
      details: err instanceof Error ? err.message : String(err),
      recommendedAction: "Fix filesystem permissions or run HiveWright from a readable application workspace.",
      requiresOwnerAction: true,
      checkedAt: now,
    });
  }
}

async function checkDatabase(sql: Sql, now: Date): Promise<DiagnosticStatus> {
  try {
    await sql`SELECT 1 AS ok`;
    return buildDiagnosticStatus({
      id: "db.connection",
      label: "Database connection",
      severity: "ok",
      summary: "Database connection succeeded.",
      checkedAt: now,
    });
  } catch (err) {
    return buildDiagnosticStatus({
      id: "db.connection",
      label: "Database connection",
      severity: "critical",
      summary: "Database connection failed.",
      details: err instanceof Error ? err.message : String(err),
      recommendedAction: "Check DATABASE_URL, PostgreSQL availability, and network reachability.",
      requiresOwnerAction: true,
      checkedAt: now,
    });
  }
}

async function checkMigrationState(sql: Sql, repoRoot: string, now: Date): Promise<DiagnosticStatus> {
  try {
    const bundled = getBundledMigrationFiles(repoRoot);
    const expected = getExpectedLatestMigration(repoRoot);
    const [row] = await sql<{ count: number | string }[]>`
      SELECT COUNT(*)::int AS count
      FROM drizzle.__drizzle_migrations
    `;
    const applied = Number(row?.count ?? 0);
    const aligned = applied >= bundled.length;
    return buildDiagnosticStatus({
      id: "db.migrations",
      label: "Database migrations",
      severity: aligned ? "ok" : "critical",
      summary: aligned
        ? `Database has ${applied} applied migration(s); latest bundled migration is ${expected.name}.`
        : `Database has ${applied} applied migration(s), but ${bundled.length} migration file(s) are bundled.`,
      recommendedAction: aligned ? undefined : "Run the app database migration command before starting runtime work.",
      requiresOwnerAction: !aligned,
      checkedAt: now,
    });
  } catch (err) {
    return buildDiagnosticStatus({
      id: "db.migrations",
      label: "Database migrations",
      severity: "warning",
      summary: "Migration state could not be verified.",
      details: err instanceof Error ? err.message : String(err),
      recommendedAction: "Run npm run check:migrations and app DB migration checks manually.",
      checkedAt: now,
    });
  }
}

async function checkDispatcherHeartbeat(sql: Sql, now: Date): Promise<DiagnosticStatus> {
  try {
    const heartbeat = await loadDispatcherHeartbeatStatus(sql, {
      now,
      staleAfterMs: DISPATCHER_STALE_AFTER_MS,
    });
    if (heartbeat.state === "fresh") {
      return buildDiagnosticStatus({
        id: "dispatcher.heartbeat",
        label: "Dispatcher heartbeat",
        severity: "ok",
        summary: "Dispatcher heartbeat is fresh.",
        details: `dispatcher=${heartbeat.dispatcherId} pid=${heartbeat.pid} host=${heartbeat.hostId} ageMs=${heartbeat.ageMs}`,
        checkedAt: now,
      });
    }
    return buildDiagnosticStatus({
      id: "dispatcher.heartbeat",
      label: "Dispatcher heartbeat",
      severity: heartbeat.state === "missing" ? "warning" : "critical",
      summary: heartbeat.state === "missing" ? "Dispatcher heartbeat is missing." : "Dispatcher heartbeat is stale.",
      details: heartbeat.lastHeartbeatAt
        ? `lastHeartbeatAt=${heartbeat.lastHeartbeatAt} ageMs=${heartbeat.ageMs}`
        : "No dispatcher heartbeat row exists for the default dispatcher.",
      recommendedAction: "Start or restart the HiveWright dispatcher, then re-check diagnostics.",
      requiresOwnerAction: heartbeat.state === "stale",
      checkedAt: now,
    });
  } catch (err) {
    return buildDiagnosticStatus({
      id: "dispatcher.heartbeat",
      label: "Dispatcher heartbeat",
      severity: "warning",
      summary: "Dispatcher heartbeat could not be read.",
      details: err instanceof Error ? err.message : String(err),
      recommendedAction: "Apply the dispatcher heartbeat migration and restart the dispatcher.",
      checkedAt: now,
    });
  }
}

async function checkQueueState(sql: Sql, now: Date): Promise<DiagnosticStatus> {
  try {
    const rows = await sql<{ status: string; count: number | string }[]>`
      SELECT status, COUNT(*)::int AS count
      FROM tasks
      WHERE status IN ('pending', 'active', 'blocked', 'failed', 'unresolvable')
      GROUP BY status
    `;
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const pending = counts.pending ?? 0;
    const active = counts.active ?? 0;
    const blocked = (counts.blocked ?? 0) + (counts.failed ?? 0) + (counts.unresolvable ?? 0);
    return buildDiagnosticStatus({
      id: "queue.state",
      label: "Queue state",
      severity: blocked > 0 ? "warning" : "ok",
      summary: `Queue has ${pending} pending, ${active} active, and ${blocked} blocked/failed/unresolvable task(s).`,
      recommendedAction: blocked > 0 ? "Review blocked and failed tasks before increasing autonomous throughput." : undefined,
      checkedAt: now,
    });
  } catch (err) {
    return buildDiagnosticStatus({
      id: "queue.state",
      label: "Queue state",
      severity: "warning",
      summary: "Queue state could not be read.",
      details: err instanceof Error ? err.message : String(err),
      checkedAt: now,
    });
  }
}

async function checkExecutionRuns(sql: Sql, now: Date): Promise<DiagnosticStatus> {
  try {
    const staleBefore = new Date(now.getTime() - EXECUTION_RUN_STALE_AFTER_MS);
    const [row] = await sql<{
      running: number | string;
      stale_running: number | string;
      recovered: number | string;
      recent_failed: number | string;
    }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'running')::int AS running,
        COUNT(*) FILTER (WHERE status = 'running' AND last_event_at < ${staleBefore})::int AS stale_running,
        COUNT(*) FILTER (WHERE status = 'interrupted' AND liveness_state = 'recovered')::int AS recovered,
        COUNT(*) FILTER (WHERE status = 'failed' AND finished_at > NOW() - INTERVAL '24 hours')::int AS recent_failed
      FROM execution_runs
    `;
    const stale = Number(row?.stale_running ?? 0);
    const failed = Number(row?.recent_failed ?? 0);
    return buildDiagnosticStatus({
      id: "execution_runs.state",
      label: "Execution runs",
      severity: stale > 0 ? "critical" : failed > 0 ? "warning" : "ok",
      summary: `${Number(row?.running ?? 0)} running run(s), ${stale} stale running run(s), ${failed} failed in the last 24h, ${Number(row?.recovered ?? 0)} recovered interruption(s).`,
      recommendedAction: stale > 0
        ? "Use HiveWright recovery controls or restart reconciliation to mark stale runs recoverable without completing business tasks."
        : failed > 0
          ? "Review recent failed execution-run evidence before retrying."
          : undefined,
      requiresOwnerAction: stale > 0,
      checkedAt: now,
    });
  } catch (err) {
    return buildDiagnosticStatus({
      id: "execution_runs.state",
      label: "Execution runs",
      severity: "warning",
      summary: "Execution-run state could not be read.",
      details: err instanceof Error ? err.message : String(err),
      checkedAt: now,
    });
  }
}

async function checkProviderState(sql: Sql, now: Date): Promise<DiagnosticStatus> {
  try {
    const rows = await sql<{ status: string; count: number | string }[]>`
      SELECT status, COUNT(*)::int AS count
      FROM model_health
      GROUP BY status
    `;
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    const unhealthy = (counts.unhealthy ?? 0) + (counts.quarantined ?? 0);
    const unknown = counts.unknown ?? 0;
    return buildDiagnosticStatus({
      id: "providers.model_health",
      label: "Model/provider health",
      severity: unhealthy > 0 ? "warning" : "ok",
      summary: `${unhealthy} unhealthy/quarantined model route(s), ${unknown} unknown route(s).`,
      recommendedAction: unhealthy > 0 ? "Run model health probes and check the affected provider service or credential." : undefined,
      checkedAt: now,
    });
  } catch (err) {
    return buildDiagnosticStatus({
      id: "providers.model_health",
      label: "Model/provider health",
      severity: "info",
      summary: "Model/provider health is unavailable for this install.",
      details: err instanceof Error ? err.message : String(err),
      recommendedAction: "Configure model health probes if provider degradation should block runtime work.",
      checkedAt: now,
    });
  }
}

export type ModelRoutePoolCapacityCounts = {
  totalRoutes: number;
  routableRoutes: number;
  disabledRoutes: number;
  unhealthyRoutes: number;
  unknownHealthRoutes: number;
  staleRoutes: number;
  freshRoutes: number;
  recoveryEligibleStaleRoutes: number;
};

export async function checkModelRoutePoolCapacity(sql: Sql, now: Date): Promise<DiagnosticStatus> {
  try {
    const modelRows = await sql<{
      provider: string;
      adapter_type: string;
      model_id: string;
      enabled: boolean;
      credential_fingerprint: string | null;
      capabilities: string[] | null;
    }[]>`
      SELECT
        hm.provider,
        hm.adapter_type,
        hm.model_id,
        hm.enabled,
        hm.capabilities,
        c.fingerprint AS credential_fingerprint
      FROM hive_models hm
      LEFT JOIN credentials c ON c.id = hm.credential_id
    `;
    const healthRows = await sql<{
      fingerprint: string;
      model_id: string;
      status: string | null;
      next_probe_at: Date | null;
    }[]>`
      SELECT fingerprint, model_id, status, next_probe_at
      FROM model_health
    `;
    const healthByRoute = new Map(healthRows.map((row) => [
      `${row.fingerprint}:${row.model_id}`,
      row,
    ]));

    const counts: ModelRoutePoolCapacityCounts = {
      totalRoutes: modelRows.length,
      routableRoutes: 0,
      disabledRoutes: 0,
      unhealthyRoutes: 0,
      unknownHealthRoutes: 0,
      staleRoutes: 0,
      freshRoutes: 0,
      recoveryEligibleStaleRoutes: 0,
    };

    for (const model of modelRows) {
      const fingerprint = model.credential_fingerprint ?? createRuntimeCredentialFingerprint({
        provider: model.provider,
        adapterType: model.adapter_type,
        baseUrl: null,
      });
      const canonicalModelId = canonicalModelIdForAdapter(model.adapter_type, model.model_id);
      const health = healthByRoute.get(`${fingerprint}:${canonicalModelId}`)
        ?? healthByRoute.get(`${fingerprint}:${model.model_id}`);
      const probeMode = getModelHealthProbePolicy({
        provider: model.provider,
        adapterType: model.adapter_type,
        modelId: canonicalModelId,
        capabilities: model.capabilities ?? [],
        sampleCostUsd: null,
      }).mode;
      const status = health?.status ?? "unknown";
      const stale = health?.next_probe_at ? health.next_probe_at <= now : false;
      if (!model.enabled) counts.disabledRoutes += 1;
      if (status === "unhealthy" || status === "quarantined") counts.unhealthyRoutes += 1;
      if (status === "unknown" && probeMode === "automatic") counts.unknownHealthRoutes += 1;
      if (stale && probeMode === "automatic") counts.staleRoutes += 1;
      else counts.freshRoutes += 1;
      if (model.enabled && status === "healthy" && !stale) counts.routableRoutes += 1;
      if (model.enabled && stale && probeMode === "automatic" && status !== "quarantined") counts.recoveryEligibleStaleRoutes += 1;
    }

    return buildModelRoutePoolCapacityDiagnostic(counts, now);
  } catch (err) {
    return buildDiagnosticStatus({
      id: "providers.route_pool_capacity",
      label: "Model route pool capacity",
      severity: "warning",
      summary: "Model route-pool capacity could not be verified.",
      details: err instanceof Error ? err.message : String(err),
      recommendedAction: "Run analyst telemetry and model health probes to verify usable model-route capacity.",
      checkedAt: now,
    });
  }
}

export function buildModelRoutePoolCapacityDiagnostic(
  counts: ModelRoutePoolCapacityCounts,
  now: Date,
): DiagnosticStatus {
  if (counts.totalRoutes === 0) {
    return buildDiagnosticStatus({
      id: "providers.route_pool_capacity",
      label: "Model route pool capacity",
      severity: "info",
      summary: "No model routes are configured for capacity scoring.",
      recommendedAction: "Configure at least one model route before expecting autonomous runtime work.",
      checkedAt: now,
    });
  }

  const constrainedRatio = counts.routableRoutes / counts.totalRoutes;
  const staleOrUnknownRoutes = counts.staleRoutes + counts.unknownHealthRoutes;
  const staleOrUnknownRatio = staleOrUnknownRoutes / counts.totalRoutes;
  const severity = counts.routableRoutes === 0 || constrainedRatio < 0.25
    ? "critical"
    : constrainedRatio < 0.5 || staleOrUnknownRatio >= 0.25
      ? "warning"
      : "ok";
  const blockedRoutes = Math.max(0, counts.totalRoutes - counts.routableRoutes);

  return buildDiagnosticStatus({
    id: "providers.route_pool_capacity",
    label: "Model route pool capacity",
    severity,
    summary: `${counts.routableRoutes}/${counts.totalRoutes} model route(s) are currently routable; ${blockedRoutes} blocked, ${counts.staleRoutes} stale, ${counts.unknownHealthRoutes} unknown.`,
    details: `fresh=${counts.freshRoutes} disabled=${counts.disabledRoutes} unhealthy=${counts.unhealthyRoutes} staleRecoveryEligible=${counts.recoveryEligibleStaleRoutes}`,
    recommendedAction: severity === "critical"
      ? "Treat route-pool capacity as degraded: run model health probe recovery and restore routable routes before presenting runtime readiness as normal."
      : counts.staleRoutes > 0
        ? "Run or wait for model health probe recovery; compare staleRecoveryEligible against stale route count to spot standing drift."
        : undefined,
    checkedAt: now,
  });
}

export async function collectRecentFailureGroups(sql: Sql = apiSql): Promise<FailureFingerprintGroup[]> {
  const rows = await sql<{
    hive_id: string | null;
    goal_id: string | null;
    task_id: string | null;
    adapter_type: string | null;
    error_message: string | null;
    updated_at: Date;
  }[]>`
    SELECT hive_id, goal_id, task_id, adapter_type, error_message, updated_at
    FROM execution_runs
    WHERE status IN ('failed', 'blocked', 'interrupted')
      AND error_message IS NOT NULL
      AND updated_at > NOW() - INTERVAL '24 hours'
    ORDER BY updated_at DESC
    LIMIT 200
  `;

  return groupFailureFingerprints(rows.map((row) => buildFailureFingerprint({
    scope: "execution_run",
    service: row.adapter_type,
    message: row.error_message ?? "unknown failure",
    affectedHiveId: row.hive_id,
    affectedGoalId: row.goal_id,
    affectedTaskId: row.task_id,
    checkedAt: row.updated_at,
  })));
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
