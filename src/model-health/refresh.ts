import type { Sql } from "postgres";
import {
  runModelHealthProbes,
  selectDueModelHealthProbeRoutes,
  type ModelProbeAdapterFactory,
  type ModelProbeRunnerResult,
} from "./probe-runner";

export interface RefreshDueModelHealthInput {
  hiveId: string;
  adapterType?: string;
  modelId?: string;
  now?: Date;
  limit?: number;
  encryptionKey?: string;
  includeOnDemand?: boolean;
  adapterFactory?: ModelProbeAdapterFactory;
}

export type RefreshDueModelHealthResult = ModelProbeRunnerResult & {
  candidates: number;
};

export async function refreshDueModelHealth(
  sql: Sql,
  input: RefreshDueModelHealthInput,
): Promise<RefreshDueModelHealthResult> {
  const routes = await selectDueModelHealthProbeRoutes(sql, {
    hiveId: input.hiveId,
    adapterType: input.adapterType,
    modelId: input.modelId,
    now: input.now,
    limit: input.limit ?? 10,
    includeOnDemand: input.includeOnDemand ?? true,
  });

  if (routes.length === 0) {
    return {
      candidates: 0,
      considered: 0,
      probed: 0,
      healthy: 0,
      unhealthy: 0,
      skippedFresh: 0,
      skippedDisabled: 0,
      skippedCredentialErrors: 0,
      errors: [],
    };
  }

  const result = await runModelHealthProbes(sql, {
    now: input.now,
    encryptionKey: input.encryptionKey,
    limit: routes.length,
    includeFresh: false,
    includeOnDemand: input.includeOnDemand ?? true,
    adapterFactory: input.adapterFactory,
    rows: routes.map((route) => ({
      hive_id: input.hiveId,
      provider: route.provider,
      model_id: route.modelId,
      health_model_id: route.healthModelId,
      adapter_type: route.adapterType,
      credential_id: route.credentialId,
      credential_key: route.credentialKey,
      credential_value: route.credentialValue,
      credential_fingerprint: route.fingerprint,
      capabilities: route.capabilities,
      sample_cost_usd: route.sampleCostUsd,
      next_probe_at: route.nextProbeAt,
    })),
  });

  return {
    candidates: routes.length,
    ...result,
  };
}
