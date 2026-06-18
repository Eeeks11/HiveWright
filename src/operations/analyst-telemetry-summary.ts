import type { Sql } from "postgres";
import { loadDispatcherHeartbeatStatus, type DispatcherHeartbeatRecord } from "@/dispatcher/heartbeat";
import { loadModelRoutingView, type ModelRoutingView } from "@/model-routing/registry";
import { buildRuntimeRouteDriftReport, type RuntimeRouteDriftReport } from "./runtime-drift-report";

export interface AnalystModelRoutingSummary {
  policySource: string;
  totalRoutes: number;
  routableRoutes: number;
  disabledRoutes: number;
  blockedRoutes: number;
  unhealthyRoutes: number;
  quarantinedRoutes: number;
  staleRoutes: number;
  freshRoutes: number;
  unknownHealthRoutes: number;
  onDemandUnknownHealthRoutes: number;
  localRoutes: number;
  automaticProbeRoutes: number;
  onDemandProbeRoutes: number;
  staleRouteRecovery: {
    staleRoutes: number;
    automaticProbeRoutes: number;
    recoveryEligibleRoutes: number;
    recoveryBlockedRoutes: number;
  };
  unknownHealthRecovery: {
    unknownHealthRoutes: number;
    automaticProbeRoutes: number;
    recoveryEligibleRoutes: number;
    recoveryBlockedRoutes: number;
  };
  readinessPolicy: {
    criticalCapacityBasis: "no_routable_or_recoverable_route";
    justification: string;
  };
  providerCounts: Record<string, number>;
  adapterCounts: Record<string, number>;
}

export interface AnalystRuntimeDriftSummary {
  dispatcherHeartbeat: Pick<DispatcherHeartbeatRecord, "state" | "ageMs" | "lastHeartbeatAt">;
  routeDrift: RuntimeRouteDriftReport;
}

export interface AnalystTelemetrySummary {
  checkedAt: string;
  hiveId: string;
  runtimeDrift: AnalystRuntimeDriftSummary;
  modelRouting: AnalystModelRoutingSummary;
  notices: string[];
}

export interface BuildAnalystTelemetrySummaryInput {
  sql: Sql;
  hiveId: string;
  now?: Date;
  loadHeartbeat?: (sql: Sql, input: { now: Date }) => Promise<DispatcherHeartbeatRecord>;
  loadRoutingView?: (sql: Sql, hiveId: string) => Promise<ModelRoutingView>;
}

export async function buildAnalystTelemetrySummary(
  input: BuildAnalystTelemetrySummaryInput,
): Promise<AnalystTelemetrySummary> {
  const now = input.now ?? new Date();
  const heartbeat = await (input.loadHeartbeat ?? defaultLoadHeartbeat)(input.sql, { now });
  const routingView = await (input.loadRoutingView ?? loadModelRoutingView)(input.sql, input.hiveId);
  const routeDrift = buildRuntimeRouteDriftReport(routingView, heartbeat);
  const modelRouting = buildAnalystModelRoutingSummary(routingView);

  return {
    checkedAt: now.toISOString(),
    hiveId: input.hiveId,
    runtimeDrift: {
      dispatcherHeartbeat: {
        state: heartbeat.state,
        ageMs: heartbeat.ageMs,
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
      },
      routeDrift,
    },
    modelRouting,
    notices: buildAnalystTelemetryNotices(routeDrift, modelRouting),
  };
}

export function buildAnalystModelRoutingSummary(
  view: Pick<ModelRoutingView, "models" | "basePolicyState">,
): AnalystModelRoutingSummary {
  const providerCounts: Record<string, number> = {};
  const adapterCounts: Record<string, number> = {};
  let routableRoutes = 0;
  let disabledRoutes = 0;
  let blockedRoutes = 0;
  let unhealthyRoutes = 0;
  let quarantinedRoutes = 0;
  let staleRoutes = 0;
  let freshRoutes = 0;
  let unknownHealthRoutes = 0;
  let onDemandUnknownHealthRoutes = 0;
  let localRoutes = 0;
  let automaticProbeRoutes = 0;
  let onDemandProbeRoutes = 0;
  let recoveryEligibleRoutes = 0;
  let unknownRecoveryEligibleRoutes = 0;

  for (const model of view.models) {
    increment(providerCounts, sanitizeBucket(model.provider));
    increment(adapterCounts, sanitizeBucket(model.adapterType));

    const enabled = model.hiveModelEnabled && model.routingEnabled;
    const healthEligible = hasFreshHealthyRouteEvidence(model);
    if (enabled && healthEligible) routableRoutes += 1;
    if (!model.hiveModelEnabled || !model.routingEnabled) disabledRoutes += 1;
    if (!enabled || !healthEligible) blockedRoutes += 1;
    if (model.status === "unhealthy") unhealthyRoutes += 1;
    if (model.status === "unknown" && model.probeMode === "automatic") unknownHealthRoutes += 1;
    if (model.status === "unknown" && model.probeMode === "on_demand") onDemandUnknownHealthRoutes += 1;
    if (model.failureClass === "quarantined") quarantinedRoutes += 1;
    if (model.probeFreshness === "due" && model.probeMode === "automatic") staleRoutes += 1;
    if (model.probeFreshness === "fresh") freshRoutes += 1;
    if (model.local) localRoutes += 1;
    if (model.probeMode === "automatic") automaticProbeRoutes += 1;
    if (model.probeMode === "on_demand") onDemandProbeRoutes += 1;
    if (model.probeFreshness === "due" && model.probeMode === "automatic" && enabled) {
      recoveryEligibleRoutes += 1;
    }
    if (model.status === "unknown" && model.probeMode === "automatic" && enabled) {
      unknownRecoveryEligibleRoutes += 1;
    }
  }

  return {
    policySource: String(view.basePolicyState.source ?? "unknown"),
    totalRoutes: view.models.length,
    routableRoutes,
    disabledRoutes,
    blockedRoutes,
    unhealthyRoutes,
    quarantinedRoutes,
    staleRoutes,
    freshRoutes,
    unknownHealthRoutes,
    onDemandUnknownHealthRoutes,
    localRoutes,
    automaticProbeRoutes,
    onDemandProbeRoutes,
    staleRouteRecovery: {
      staleRoutes,
      automaticProbeRoutes,
      recoveryEligibleRoutes,
      recoveryBlockedRoutes: Math.max(0, staleRoutes - recoveryEligibleRoutes),
    },
    unknownHealthRecovery: {
      unknownHealthRoutes,
      automaticProbeRoutes,
      recoveryEligibleRoutes: unknownRecoveryEligibleRoutes,
      recoveryBlockedRoutes: Math.max(0, unknownHealthRoutes - unknownRecoveryEligibleRoutes),
    },
    readinessPolicy: {
      criticalCapacityBasis: "no_routable_or_recoverable_route",
      justification: "Readiness treats route-pool capacity as critical only when there is neither a currently routable model route nor an enabled automatic route that probe recovery can restore; broader stale or unknown inventory remains warning-level drift for analyst follow-up.",
    },
    providerCounts,
    adapterCounts,
  };
}

function buildAnalystTelemetryNotices(
  routeDrift: RuntimeRouteDriftReport,
  modelRouting: AnalystModelRoutingSummary,
): string[] {
  const notices: string[] = [];
  if (routeDrift.status !== "in_sync") {
    notices.push(`Runtime drift status is ${routeDrift.status}.`);
  }
  if (modelRouting.blockedRoutes > 0) {
    notices.push(`${modelRouting.blockedRoutes} model route(s) are disabled, blocked, or unhealthy.`);
  }
  if (modelRouting.quarantinedRoutes > 0) {
    notices.push(`${modelRouting.quarantinedRoutes} model route(s) are quarantined.`);
  }
  if (modelRouting.staleRoutes > 0) {
    notices.push(`${modelRouting.staleRoutes} automatically probed model route(s) have stale probe evidence.`);
  }
  if (modelRouting.onDemandUnknownHealthRoutes > 0) {
    notices.push(`${modelRouting.onDemandUnknownHealthRoutes} on-demand model route(s) have no automatic health evidence and are excluded from unknown-health debt.`);
  }
  if (notices.length === 0) notices.push("Runtime drift and model routing summaries are in sync.");
  return notices;
}

function sanitizeBucket(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  return normalized || "unknown";
}

function increment(record: Record<string, number>, key: string) {
  record[key] = (record[key] ?? 0) + 1;
}

function hasFreshHealthyRouteEvidence(model: {
  status: string;
  probeFreshness: string;
}): boolean {
  return model.status === "healthy" && model.probeFreshness === "fresh";
}

async function defaultLoadHeartbeat(sql: Sql, input: { now: Date }): Promise<DispatcherHeartbeatRecord> {
  return loadDispatcherHeartbeatStatus(sql, { now: input.now });
}
