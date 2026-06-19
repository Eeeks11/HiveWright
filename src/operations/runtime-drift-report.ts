import { execFileSync } from "node:child_process";
import type { Sql } from "postgres";
import { loadDispatcherHeartbeatStatus, type DispatcherHeartbeatRecord } from "@/dispatcher/heartbeat";
import { loadModelRoutingView, type ModelRoutingView } from "@/model-routing/registry";
import { readLatestTaskContextProvenance } from "@/provenance/task-context";
import type { ContextProvenance } from "@/adapters/types";
import { getHiveOperatorVerdict, type HiveOperatorVerdict } from "./operator-verdict";
import { fetchLatestSupervisorReport, summarizeSupervisorReport, type SupervisorReportSummary } from "@/app/api/supervisor-reports/queries";

const MODULE_BOOT_TIME = new Date();

export type RuntimeDriftStatus = "in_sync" | "drift" | "runtime_unavailable";

export interface RuntimeBuildProvenance {
  repoPath: string;
  gitSha: string | null;
  buildHash: string | null;
  bootTime: string;
}

export interface RuntimeRouteDriftReport {
  status: RuntimeDriftStatus;
  declaredCandidates: number;
  explicitDeclaredCandidates: number;
  runtimeProjectedCandidates: number;
  projectedInventoryBasis: "declared_policy" | "configured_route_inventory" | "usable_runtime_routes";
  inventoryExpectation: "declared_policy" | "broader_usable_capacity_repaired" | "fixed_inventory_unconfigured";
  inventoryJustification: string;
  blockedRoutes: number;
  quarantinedRoutes: number;
  staleRoutes: number;
  freshRoutes: number;
  unknownHealthRoutes: number;
  onDemandUnknownHealthRoutes: number;
  staleRecovery: {
    staleRoutes: number;
    automaticProbeRoutes: number;
    recoveryEligibleRoutes: number;
  };
  driftReasons: string[];
}

export interface RuntimeDriftOperatorReport {
  checkedAt: string;
  hiveId: string;
  runtime: RuntimeBuildProvenance;
  dispatcherHeartbeat: DispatcherHeartbeatRecord;
  routeDrift: RuntimeRouteDriftReport;
  provenance: ContextProvenance;
  supervisorReport: SupervisorReportSummary | null;
  operatorVerdict: Pick<HiveOperatorVerdict, "status" | "canRunNow" | "summary" | "blockers" | "signals">;
}

export interface BuildRuntimeDriftOperatorReportInput {
  sql: Sql;
  hiveId: string;
  taskId?: string | null;
  now?: Date;
  repoPath?: string;
  bootTime?: Date;
  env?: NodeJS.ProcessEnv;
  loadHeartbeat?: (sql: Sql, input: { now: Date }) => Promise<DispatcherHeartbeatRecord>;
  loadRoutingView?: (sql: Sql, hiveId: string) => Promise<ModelRoutingView>;
  loadOperatorVerdict?: (sql: Sql, input: { hiveId: string; now: Date }) => Promise<HiveOperatorVerdict>;
  loadProvenance?: (sql: Sql, taskId: string) => Promise<ContextProvenance>;
  loadSupervisorSummary?: (sql: Sql, hiveId: string) => Promise<SupervisorReportSummary | null>;
  gitSha?: string | null;
}

export async function buildRuntimeDriftOperatorReport(
  input: BuildRuntimeDriftOperatorReportInput,
): Promise<RuntimeDriftOperatorReport> {
  const now = input.now ?? new Date();
  const repoPath = input.repoPath ?? process.cwd();
  const heartbeat = await (input.loadHeartbeat ?? defaultLoadHeartbeat)(input.sql, { now });
  const routingView = await (input.loadRoutingView ?? loadModelRoutingView)(input.sql, input.hiveId);
  const operatorVerdict = await (input.loadOperatorVerdict ?? getHiveOperatorVerdict)(input.sql, {
    hiveId: input.hiveId,
    now,
  });
  const supervisorReport = await (input.loadSupervisorSummary ?? defaultLoadSupervisorSummary)(
    input.sql,
    input.hiveId,
  );
  const provenance: ContextProvenance = input.taskId
    ? await (input.loadProvenance ?? readLatestTaskContextProvenance)(input.sql, input.taskId)
    : { status: "unavailable", entries: [], disclaimer: "No taskId was supplied for provenance lookup." };

  return {
    checkedAt: now.toISOString(),
    hiveId: input.hiveId,
    runtime: buildRuntimeBuildProvenance({
      repoPath,
      bootTime: input.bootTime ?? MODULE_BOOT_TIME,
      env: input.env,
      gitSha: input.gitSha,
    }),
    dispatcherHeartbeat: heartbeat,
    routeDrift: buildRuntimeRouteDriftReport(routingView, heartbeat),
    provenance,
    supervisorReport,
    operatorVerdict: {
      status: operatorVerdict.status,
      canRunNow: operatorVerdict.canRunNow,
      summary: operatorVerdict.summary,
      blockers: operatorVerdict.blockers,
      signals: operatorVerdict.signals,
    },
  };
}

export function buildRuntimeBuildProvenance(input: {
  repoPath: string;
  bootTime: Date;
  env?: NodeJS.ProcessEnv;
  gitSha?: string | null;
}): RuntimeBuildProvenance {
  const env = input.env ?? process.env;
  const buildHash = env.VERCEL_GIT_COMMIT_SHA ?? env.HIVEWRIGHT_BUILD_HASH ?? null;
  return {
    repoPath: input.repoPath,
    gitSha: input.gitSha ?? buildHash ?? readGitSha(input.repoPath),
    buildHash,
    bootTime: input.bootTime.toISOString(),
  };
}

export function buildRuntimeRouteDriftReport(
  view: Pick<ModelRoutingView, "models" | "policy" | "basePolicyState">,
  heartbeat: Pick<DispatcherHeartbeatRecord, "state">,
): RuntimeRouteDriftReport {
  const explicitDeclaredCandidates = view.basePolicyState.policy?.candidates.length ?? 0;
  const configuredRouteInventory = view.policy.candidates.length;
  const runtimeUsableCandidates = view.policy.candidates.filter((candidate) => (
    candidate.enabled !== false && hasFreshHealthyRouteEvidence(candidate)
  )).length;
  const declaredCandidates = explicitDeclaredCandidates > 0 ? explicitDeclaredCandidates : configuredRouteInventory;
  const runtimeProjectedCandidates = explicitDeclaredCandidates > 0
    ? configuredRouteInventory
    : configuredRouteInventory > 0
      ? configuredRouteInventory
      : runtimeUsableCandidates;
  const projectedInventoryBasis = explicitDeclaredCandidates > 0
    ? "declared_policy"
    : configuredRouteInventory > 0
      ? "configured_route_inventory"
      : "usable_runtime_routes";
  const inventoryExpectation = explicitDeclaredCandidates > 0
    ? "declared_policy"
    : configuredRouteInventory > 0
      ? "broader_usable_capacity_repaired"
      : "fixed_inventory_unconfigured";
  const inventoryJustification = explicitDeclaredCandidates > 0
    ? "Model routing declares an explicit candidate set in policy configuration."
    : configuredRouteInventory > 0
      ? "No explicit model-routing policy candidates exist, so telemetry declares the configured hive model inventory as the route pool expected to regain broader usable capacity."
      : "No explicit policy candidates or configured hive model routes exist; the route pool is intentionally empty until models are configured.";
  const policyCandidatesByRoute = new Map(view.policy.candidates.map((candidate) => [
    `${candidate.adapterType}:${candidate.model}`,
    candidate,
  ]));
  const isExpectedAutomaticRoute = (model: ModelRoutingView["models"][number]): boolean => {
    const candidate = policyCandidatesByRoute.get(`${model.adapterType}:${model.model}`);
    const membership = candidate?.canonicalRouteSet?.membership;
    return membership !== "excluded" && membership !== "intentionally_disabled";
  };
  const expectedAutomaticModels = view.models.filter(isExpectedAutomaticRoute);
  const blockedRoutes = expectedAutomaticModels.filter((model) => (
    !model.hiveModelEnabled || !model.routingEnabled || !hasFreshHealthyRouteEvidence(model)
  )).length;
  const quarantinedRoutes = expectedAutomaticModels.filter((model) => model.failureClass === "quarantined").length;
  const staleRoutes = expectedAutomaticModels.filter((model) => model.probeFreshness === "due" && model.probeMode === "automatic").length;
  const freshRoutes = expectedAutomaticModels.filter((model) => model.probeFreshness === "fresh").length;
  const unknownHealthRoutes = expectedAutomaticModels.filter((model) => model.status === "unknown" && model.probeMode === "automatic").length;
  const onDemandUnknownHealthRoutes = expectedAutomaticModels.filter((model) => model.status === "unknown" && model.probeMode === "on_demand").length;
  const automaticProbeRoutes = expectedAutomaticModels.filter((model) => model.probeMode === "automatic").length;
  const recoveryEligibleRoutes = expectedAutomaticModels.filter((model) => (
    model.probeFreshness === "due" && model.probeMode === "automatic" && model.hiveModelEnabled && model.routingEnabled
  )).length;
  const driftReasons: string[] = [];

  if (declaredCandidates !== runtimeProjectedCandidates) {
    driftReasons.push(
      `declared candidates (${declaredCandidates}) differ from runtime-projected candidates (${runtimeProjectedCandidates})`,
    );
  }
  if (projectedInventoryBasis === "configured_route_inventory") {
    driftReasons.push("declared candidates are derived from configured hive model inventory because no explicit routing policy candidates exist");
  }
  if (projectedInventoryBasis === "usable_runtime_routes") {
    driftReasons.push("runtime-projected candidates are narrowed to usable runtime routes because no declared policy candidates or configured hive model routes exist");
  }
  if (heartbeat.state !== "fresh") {
    driftReasons.push(`dispatcher heartbeat is ${heartbeat.state}`);
  }
  if (blockedRoutes > 0) driftReasons.push(`${blockedRoutes} route(s) are blocked or disabled`);
  if (quarantinedRoutes > 0) driftReasons.push(`${quarantinedRoutes} route(s) are quarantined`);
  if (staleRoutes > 0) driftReasons.push(`${staleRoutes} route(s) have stale probe evidence`);
  if (unknownHealthRoutes > 0) driftReasons.push(`${unknownHealthRoutes} route(s) have unknown health`);

  return {
    status: heartbeat.state === "missing" ? "runtime_unavailable" : driftReasons.length > 0 ? "drift" : "in_sync",
    declaredCandidates,
    explicitDeclaredCandidates,
    runtimeProjectedCandidates,
    projectedInventoryBasis,
    inventoryExpectation,
    inventoryJustification,
    blockedRoutes,
    quarantinedRoutes,
    staleRoutes,
    freshRoutes,
    unknownHealthRoutes,
    onDemandUnknownHealthRoutes,
    staleRecovery: {
      staleRoutes,
      automaticProbeRoutes,
      recoveryEligibleRoutes,
    },
    driftReasons,
  };
}

async function defaultLoadHeartbeat(sql: Sql, input: { now: Date }): Promise<DispatcherHeartbeatRecord> {
  return loadDispatcherHeartbeatStatus(sql, { now: input.now });
}

async function defaultLoadSupervisorSummary(sql: Sql, hiveId: string): Promise<SupervisorReportSummary | null> {
  return summarizeSupervisorReport(await fetchLatestSupervisorReport(sql, hiveId));
}

function hasFreshHealthyRouteEvidence(model: {
  status?: string;
  probeFreshness?: string;
}): boolean {
  return model.status === "healthy" && model.probeFreshness === "fresh";
}

function readGitSha(repoPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim() || null;
  } catch {
    return null;
  }
}
