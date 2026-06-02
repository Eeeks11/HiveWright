import type { Sql } from "postgres";
import { provisionerFor as defaultProvisionerFor } from "@/provisioning";
import type { Provisioner } from "@/provisioning/types";
import { checkModelSpawnHealth, type ModelSpawnHealthDecision } from "@/model-health/spawn-gate";
import { refreshDueModelHealth } from "@/model-health/refresh";
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
}

export async function checkDispatcherModelRouteHealth(
  sql: Sql,
  input: DispatcherModelRouteHealthInput,
): Promise<DispatcherModelRouteHealthDecision> {
  let modelHealth = await checkModelSpawnHealth(sql, {
    hiveId: input.hiveId,
    adapterType: input.adapterType,
    modelId: input.modelId,
    now: input.now,
  });

  if (!modelHealth.canRun && isRefreshableModelHealthReason(modelHealth.reason)) {
    try {
      await refreshDueModelHealth(sql, {
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
    } catch (err) {
      return {
        healthy: false,
        reason: modelHealth.reason,
        detail: `model health refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        modelHealth,
      };
    }
  }

  if (!modelHealth.canRun) {
    return {
      healthy: false,
      reason: modelHealth.reason,
      detail: modelHealth.failureReason ?? undefined,
      modelHealth,
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
    };
  }

  return {
    healthy: true,
    reason: "model_health_and_provisioner_healthy",
    modelHealth,
  };
}

function isRefreshableModelHealthReason(reason: ModelSpawnHealthDecision["reason"]): boolean {
  return reason === "health_probe_missing" ||
    reason === "health_probe_stale" ||
    reason === "health_probe_unhealthy";
}
