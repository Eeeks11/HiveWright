import type { Sql } from "postgres";
import { canonicalModelIdForAdapter } from "@/model-health/model-identity";
import { checkModelSpawnHealth, type ModelSpawnHealthReason } from "@/model-health/spawn-gate";
import { normalizeEaModel } from "./runner";

export const DEFAULT_EA_PRIMARY_MODEL = "openai-codex/gpt-5.6-sol";
export const DEFAULT_EA_FALLBACK_MODEL = "openai-codex/gpt-5.5";

export interface EaModelConfiguration {
  primaryModel: string | null;
  fallbackModel: string | null;
}

export type EaModelRouteSelection = "primary" | "fallback" | "runtime_default";

export interface EaModelRoute {
  model: string | undefined;
  selected: EaModelRouteSelection;
  reason: string;
  primaryModel: string | null;
  fallbackModel: string | null;
}

export type EaModelTransport = "dashboard" | "voice" | "discord";

interface EaModelConfigurationRow {
  primaryModel: string | null;
  fallbackModel: string | null;
}

interface LegacyEaConnectorRow {
  config: Record<string, unknown> | null;
}

function canonicalEaModel(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const normalized = normalizeEaModel(model);
  if (!normalized) return null;
  if (normalized === "gpt-5.6" || normalized === "openai-codex/gpt-5.6") {
    return DEFAULT_EA_PRIMARY_MODEL;
  }
  return canonicalModelIdForAdapter("codex", normalized);
}

export async function getEaModelConfiguration(
  sql: Sql,
  hiveId: string,
): Promise<EaModelConfiguration> {
  const [row] = await sql<EaModelConfigurationRow[]>`
    SELECT primary_model AS "primaryModel", fallback_model AS "fallbackModel"
    FROM ea_model_configurations
    WHERE hive_id = ${hiveId}
  `;
  if (!row) return { primaryModel: null, fallbackModel: null };
  return {
    primaryModel: canonicalEaModel(row.primaryModel),
    fallbackModel: canonicalEaModel(row.fallbackModel),
  };
}

export async function updateEaModelConfiguration(
  sql: Sql,
  hiveId: string,
  input: EaModelConfiguration,
): Promise<EaModelConfiguration> {
  const primaryModel = canonicalEaModel(input.primaryModel);
  const fallbackModel = canonicalEaModel(input.fallbackModel);
  await sql`
    INSERT INTO ea_model_configurations (hive_id, primary_model, fallback_model)
    VALUES (${hiveId}, ${primaryModel}, ${fallbackModel})
    ON CONFLICT (hive_id) DO UPDATE SET
      primary_model = EXCLUDED.primary_model,
      fallback_model = EXCLUDED.fallback_model,
      updated_at = NOW()
  `;
  return { primaryModel, fallbackModel };
}

export async function recordEaModelRouteTelemetry(
  sql: Sql,
  input: {
    hiveId: string;
    transport: EaModelTransport;
    route: EaModelRoute;
    voiceSessionId?: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO ea_model_route_events (
      hive_id, transport, voice_session_id, selected, model_id, reason
    )
    VALUES (
      ${input.hiveId},
      ${input.transport},
      ${input.voiceSessionId ?? null},
      ${input.route.selected},
      ${input.route.model ?? null},
      ${input.route.reason.slice(0, 255)}
    )
  `;
}

async function checkConfiguredModel(
  sql: Sql,
  hiveId: string,
  model: string,
): Promise<{ model: string; canRun: boolean; reason: ModelSpawnHealthReason }> {
  const canonical = canonicalEaModel(model) ?? model;
  const decision = await checkModelSpawnHealth(sql, {
    hiveId,
    adapterType: "codex",
    modelId: canonical,
  });
  return { model: canonical, canRun: decision.canRun, reason: decision.reason };
}

export async function resolveEaModelRoute(
  sql: Sql,
  hiveId: string,
  options: { preferFallback?: boolean } = {},
): Promise<EaModelRoute> {
  const config = await getEaModelConfiguration(sql, hiveId);
  const { primaryModel, fallbackModel } = config;
  if (!primaryModel && !fallbackModel) {
    return {
      model: undefined,
      selected: "runtime_default",
      reason: "configuration_missing",
      ...config,
    };
  }

  if (options.preferFallback) {
    if (!fallbackModel) {
      return {
        model: undefined,
        selected: "runtime_default",
        reason: "budget_fallback_not_configured",
        ...config,
      };
    }
    const fallback = await checkConfiguredModel(sql, hiveId, fallbackModel);
    return fallback.canRun
      ? { model: fallback.model, selected: "fallback", reason: "budget_fallback", ...config }
      : {
          model: undefined,
          selected: "runtime_default",
          reason: `fallback_${fallback.reason}`,
          ...config,
        };
  }

  let primaryFailure: ModelSpawnHealthReason | null = null;
  if (primaryModel) {
    const primary = await checkConfiguredModel(sql, hiveId, primaryModel);
    if (primary.canRun) {
      return { model: primary.model, selected: "primary", reason: primary.reason, ...config };
    }
    primaryFailure = primary.reason;
  }

  if (fallbackModel) {
    const fallback = await checkConfiguredModel(sql, hiveId, fallbackModel);
    if (fallback.canRun) {
      return {
        model: fallback.model,
        selected: "fallback",
        reason: primaryFailure ? `primary_${primaryFailure}` : "primary_not_configured",
        ...config,
      };
    }
    return {
      model: undefined,
      selected: "runtime_default",
      reason: primaryFailure
        ? `primary_${primaryFailure};fallback_${fallback.reason}`
        : `fallback_${fallback.reason}`,
      ...config,
    };
  }

  return {
    model: undefined,
    selected: "runtime_default",
    reason: primaryFailure ? `primary_${primaryFailure}` : "configuration_missing",
    ...config,
  };
}

/**
 * Backward-compatible loader used by older transport call sites. Shared
 * per-hive configuration wins; a legacy connector-local model is consulted
 * only when the migration has not produced a configuration row.
 */
export async function loadGovernedEaModel(
  sql: Sql,
  hiveId: string,
  connectorSlugs: string[] = ["ea-discord"],
): Promise<string | undefined> {
  const route = await resolveEaModelRoute(sql, hiveId);
  if (route.reason !== "configuration_missing") return route.model;

  const [legacy] = await sql<LegacyEaConnectorRow[]>`
    SELECT config
    FROM connector_installs
    WHERE hive_id = ${hiveId}
      AND connector_slug = ANY(${connectorSlugs})
      AND status = 'active'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `;
  const configured = canonicalEaModel(legacy?.config?.model);
  return configured
    ? (await resolveGovernedEaModel(sql, hiveId, configured))
    : undefined;
}

export async function resolveGovernedEaModel(
  sql: Sql,
  hiveId: string,
  configuredModel: string | null | undefined,
): Promise<string | undefined> {
  const model = canonicalEaModel(configuredModel);
  if (!model) return undefined;
  const decision = await checkConfiguredModel(sql, hiveId, model);
  return decision.canRun ? decision.model : undefined;
}
