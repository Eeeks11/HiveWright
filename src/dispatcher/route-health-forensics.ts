import type { DispatcherModelRouteHealthDecision } from "./adapter-health";
import type { ProviderFailoverDecision } from "./provider-failover";
import {
  resolveHiveWrightBuildProvenance,
  type HiveWrightBuildProvenance,
} from "@/diagnostics/build-provenance";

export interface RuntimeHealthGateForensicsInput {
  primaryAdapterType: string;
  primaryModel: string;
  fallbackAdapterType?: string | null;
  fallbackModel?: string | null;
  primaryHealth: DispatcherModelRouteHealthDecision;
  fallbackHealth?: DispatcherModelRouteHealthDecision | null;
  route: ProviderFailoverDecision;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export interface RuntimeHealthGateForensics extends Record<string, unknown> {
  routeStage: "runtime_health_gate";
  blockedBeforeSpawn: true;
  sessionSemantics: {
    sessionId: null;
    adapterSessionExpected: false;
    executionCapsuleExpected: false;
    reason: "dispatcher_blocked_before_adapter_session_startup";
  };
  routeDeclaration: {
    primaryAdapterType: string;
    primaryModel: string;
    fallbackAdapterType: string | null;
    fallbackModel: string | null;
  };
  routeDecision: ProviderFailoverDecision;
  runtimeHealthGate: {
    capturedAt: string;
    primary: PersistedRouteHealthDecision;
    fallback: PersistedRouteHealthDecision | null;
  };
  buildProvenance: HiveWrightBuildProvenance;
}

export interface PersistedRouteHealthDecision {
  healthy: boolean;
  reason: string;
  detail: string | null;
  modelHealth: {
    canRun: boolean;
    reason: string;
    status: string | null;
    fingerprint: string | null;
    lastProbedAt: string | null;
    nextProbeAt: string | null;
    failureReason: string | null;
  };
  refresh: {
    attempted: boolean;
    initialReason: string | null;
    outcome: string;
    finalReason: string | null;
    detail: string | null;
    result: Record<string, number> | null;
  };
}

export function buildRuntimeHealthGateForensics(
  input: RuntimeHealthGateForensicsInput,
): RuntimeHealthGateForensics {
  const now = input.now ?? new Date();
  return {
    routeStage: "runtime_health_gate",
    blockedBeforeSpawn: true,
    sessionSemantics: {
      sessionId: null,
      adapterSessionExpected: false,
      executionCapsuleExpected: false,
      reason: "dispatcher_blocked_before_adapter_session_startup",
    },
    routeDeclaration: {
      primaryAdapterType: input.primaryAdapterType,
      primaryModel: input.primaryModel,
      fallbackAdapterType: input.fallbackAdapterType ?? null,
      fallbackModel: input.fallbackModel ?? null,
    },
    routeDecision: {
      adapterType: input.route.adapterType,
      model: input.route.model,
      canRun: input.route.canRun,
      usedFallback: input.route.usedFallback,
      clearFallbackModel: input.route.clearFallbackModel,
      reason: input.route.reason,
      diagnostic: input.route.diagnostic,
    },
    runtimeHealthGate: {
      capturedAt: now.toISOString(),
      primary: persistRouteHealthDecision(input.primaryHealth),
      fallback: input.fallbackHealth ? persistRouteHealthDecision(input.fallbackHealth) : null,
    },
    buildProvenance: resolveHiveWrightBuildProvenance({
      env: input.env,
      now,
      repoRoot: input.repoRoot,
    }),
  };
}

function persistRouteHealthDecision(
  decision: DispatcherModelRouteHealthDecision,
): PersistedRouteHealthDecision {
  return {
    healthy: decision.healthy,
    reason: decision.reason,
    detail: decision.detail ?? null,
    modelHealth: {
      canRun: decision.modelHealth.canRun,
      reason: decision.modelHealth.reason,
      status: decision.modelHealth.status ?? null,
      fingerprint: decision.modelHealth.fingerprint ?? null,
      lastProbedAt: decision.modelHealth.lastProbedAt?.toISOString() ?? null,
      nextProbeAt: decision.modelHealth.nextProbeAt?.toISOString() ?? null,
      failureReason: decision.modelHealth.failureReason ?? null,
    },
    refresh: {
      attempted: decision.refresh.attempted,
      initialReason: decision.refresh.initialReason ?? null,
      outcome: decision.refresh.outcome,
      finalReason: decision.refresh.finalReason ?? null,
      detail: decision.refresh.detail ?? null,
      result: decision.refresh.result ? { ...decision.refresh.result } : null,
    },
  };
}
