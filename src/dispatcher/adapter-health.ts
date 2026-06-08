import type { Sql } from "postgres";
import { provisionerFor as defaultProvisionerFor } from "@/provisioning";
import type { Provisioner } from "@/provisioning/types";
import { checkModelSpawnHealth, type ModelSpawnHealthDecision } from "@/model-health/spawn-gate";
import { refreshDueModelHealth, type RefreshDueModelHealthResult } from "@/model-health/refresh";
import type { ModelProbeAdapterFactory } from "@/model-health/probe-runner";

export type DispatcherModelRouteHealthReason =
  | "model_health_and_provisioner_healthy"
  | "provisioner_missing"
  | "provisioner_unhealthy"
  | ModelSpawnHealthDecision["reason"];

export interface DispatcherModelRouteHealthInput {
  hiveId: string;
  roleSlug: string;
  adapterType: string;
  modelId: string;
  now?: Date;
  provisionerFor?: (adapterType: string) => Provisioner | null;
  modelHealthAdapterFactory?: ModelProbeAdapterFactory;
  modelHealthEncryptionKey?: string;
}

export interface DispatcherModelRouteHealthDecision {
  healthy: boolean;
  reason: DispatcherModelRouteHealthReason;
  detail?: string;
  modelHealth: ModelSpawnHealthDecision;
  refresh: DispatcherModelRouteRefreshDecision;
}

export interface DispatcherModelRouteRefreshDecision {
  attempted: boolean;
  initialReason: ModelSpawnHealthDecision["reason"] | null;
  outcome: "not_needed" | "recovered" | "still_unhealthy" | "refresh_failed";
  finalReason: ModelSpawnHealthDecision["reason"] | null;
  detail?: string;
  result?: DispatcherModelRouteRefreshSummary;
}

export interface DispatcherModelRouteRefreshSummary {
  candidates: number;
  considered: number;
  probed: number;
  healthy: number;
  unhealthy: number;
  skippedFresh: number;
  skippedDisabled: number;
  skippedCredentialErrors: number;
  errors: number;
}

export async function checkDispatcherModelRouteHealth(
  sql: Sql,
  input: DispatcherModelRouteHealthInput,
): Promise<DispatcherModelRouteHealthDecision> {
  let refresh = createNoRefreshDecision();
  let modelHealth = await checkModelSpawnHealth(sql, {
    hiveId: input.hiveId,
    adapterType: input.adapterType,
    modelId: input.modelId,
    now: input.now,
  });

  if (!modelHealth.canRun && isRefreshableModelHealthReason(modelHealth.reason)) {
    const initialReason = modelHealth.reason;
    try {
      const refreshResult = await refreshDueModelHealth(sql, {
        hiveId: input.hiveId,
        adapterType: input.adapterType,
        modelId: input.modelId,
        now: input.now,
        limit: 1,
        encryptionKey: input.modelHealthEncryptionKey ?? process.env.ENCRYPTION_KEY,
        includeOnDemand: true,
        adapterFactory: input.modelHealthAdapterFactory,
      });
      modelHealth = await checkModelSpawnHealth(sql, {
        hiveId: input.hiveId,
        adapterType: input.adapterType,
        modelId: input.modelId,
        now: input.now,
      });
      refresh = {
        attempted: true,
        initialReason,
        outcome: modelHealth.canRun ? "recovered" : "still_unhealthy",
        finalReason: modelHealth.reason,
        result: summariseRefreshResult(refreshResult),
      };
    } catch (err) {
      const detail = `model health refresh failed: ${err instanceof Error ? err.message : String(err)}`;
      return {
        healthy: false,
        reason: modelHealth.reason,
        detail,
        modelHealth,
        refresh: {
          attempted: true,
          initialReason,
          outcome: "refresh_failed",
          finalReason: modelHealth.reason,
          detail,
        },
      };
    }
  }

  if (!modelHealth.canRun) {
    return {
      healthy: false,
      reason: modelHealth.reason,
      detail: modelHealth.failureReason ?? undefined,
      modelHealth,
      refresh,
    };
  }

  const provisionerFor = input.provisionerFor ?? defaultProvisionerFor;
  const provisioner = provisionerFor(input.adapterType);
  if (!provisioner) {
    return {
      healthy: false,
      reason: "provisioner_missing",
      detail: `No provisioner registered for adapter ${input.adapterType}`,
      modelHealth,
      refresh,
    };
  }

  const provision = await provisioner.check({
    slug: input.roleSlug,
    recommendedModel: input.modelId,
  });
  if (!provision.satisfied) {
    return {
      healthy: false,
      reason: "provisioner_unhealthy",
      detail: provision.reason,
      modelHealth,
      refresh,
    };
  }

  return {
    healthy: true,
    reason: "model_health_and_provisioner_healthy",
    modelHealth,
    refresh,
  };
}

function isRefreshableModelHealthReason(reason: ModelSpawnHealthDecision["reason"]): boolean {
  return reason === "health_probe_missing" ||
    reason === "health_probe_stale" ||
    reason === "health_probe_unhealthy";
}

function createNoRefreshDecision(): DispatcherModelRouteRefreshDecision {
  return {
    attempted: false,
    initialReason: null,
    outcome: "not_needed",
    finalReason: null,
  };
}

function summariseRefreshResult(
  result: RefreshDueModelHealthResult,
): DispatcherModelRouteRefreshSummary {
  return {
    candidates: result.candidates,
    considered: result.considered,
    probed: result.probed,
    healthy: result.healthy,
    unhealthy: result.unhealthy,
    skippedFresh: result.skippedFresh,
    skippedDisabled: result.skippedDisabled,
    skippedCredentialErrors: result.skippedCredentialErrors,
    errors: result.errors.length,
  };
}
