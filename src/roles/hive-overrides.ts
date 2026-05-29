import type { Sql, TransactionSql } from "postgres";

export const HIVE_ROLE_OVERRIDES_ADAPTER_CONFIG_TYPE = "hive-role-overrides";

export type HiveRoleOverride = {
  adapterType?: string | null;
  recommendedModel?: string | null;
  fallbackAdapterType?: string | null;
  fallbackModel?: string | null;
  toolsConfig?: unknown;
};

export type HiveRoleOverrides = Record<string, HiveRoleOverride>;

type SqlExecutor = Sql | TransactionSql;

export async function loadHiveRoleOverrides(
  sql: SqlExecutor,
  hiveId: string | null | undefined,
): Promise<HiveRoleOverrides> {
  if (!hiveId) return {};
  const [row] = await sql<{ config: unknown }[]>`
    SELECT config
    FROM adapter_config
    WHERE adapter_type = ${HIVE_ROLE_OVERRIDES_ADAPTER_CONFIG_TYPE}
      AND hive_id = ${hiveId}::uuid
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  return normalizeHiveRoleOverrides(row?.config);
}

export async function loadHiveRoleOverride(
  sql: SqlExecutor,
  hiveId: string | null | undefined,
  roleSlug: string,
): Promise<HiveRoleOverride | null> {
  const overrides = await loadHiveRoleOverrides(sql, hiveId);
  return overrides[roleSlug] ?? null;
}

export async function saveHiveRoleOverride(
  sql: SqlExecutor,
  hiveId: string,
  roleSlug: string,
  patch: HiveRoleOverride,
): Promise<void> {
  const current = await loadHiveRoleOverrides(sql, hiveId);
  const nextRole = pruneOverride({
    ...(current[roleSlug] ?? {}),
    ...patch,
  });
  const next = { ...current };
  if (Object.keys(nextRole).length === 0) {
    delete next[roleSlug];
  } else {
    next[roleSlug] = nextRole;
  }
  await saveHiveRoleOverrides(sql, hiveId, next);
}

export async function saveHiveRoleOverrides(
  sql: SqlExecutor,
  hiveId: string,
  overrides: HiveRoleOverrides,
): Promise<void> {
  const config = normalizeHiveRoleOverrides(overrides);
  const jsonConfig = config as Parameters<Sql["json"]>[0];
  const [existing] = await sql<{ id: string }[]>`
    SELECT id
    FROM adapter_config
    WHERE adapter_type = ${HIVE_ROLE_OVERRIDES_ADAPTER_CONFIG_TYPE}
      AND hive_id = ${hiveId}::uuid
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (existing?.id) {
    await sql`
      UPDATE adapter_config
      SET config = ${sql.json(jsonConfig)}, updated_at = NOW()
      WHERE id = ${existing.id}
    `;
    return;
  }
  await sql`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (${hiveId}::uuid, ${HIVE_ROLE_OVERRIDES_ADAPTER_CONFIG_TYPE}, ${sql.json(jsonConfig)})
  `;
}

export function applyHiveRoleOverride<T extends {
  adapter_type?: string | null;
  recommended_model?: string | null;
  fallback_adapter_type?: string | null;
  fallback_model?: string | null;
  tools_config?: unknown;
}>(role: T, override: HiveRoleOverride | null | undefined): T {
  if (!override) return role;
  return {
    ...role,
    adapter_type: override.adapterType !== undefined ? override.adapterType : role.adapter_type,
    recommended_model: override.recommendedModel !== undefined ? override.recommendedModel : role.recommended_model,
    fallback_adapter_type: override.fallbackAdapterType !== undefined ? override.fallbackAdapterType : role.fallback_adapter_type,
    fallback_model: override.fallbackModel !== undefined ? override.fallbackModel : role.fallback_model,
    tools_config: override.toolsConfig !== undefined ? override.toolsConfig : role.tools_config,
  };
}

export function normalizeHiveRoleOverrides(value: unknown): HiveRoleOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const out: HiveRoleOverrides = {};
  for (const [roleSlug, raw] of Object.entries(source)) {
    const slug = roleSlug.trim();
    if (!slug || !raw || typeof raw !== "object") continue;
    const override = normalizeHiveRoleOverride(raw as Record<string, unknown>);
    if (Object.keys(override).length > 0) out[slug] = override;
  }
  return out;
}

function normalizeHiveRoleOverride(source: Record<string, unknown>): HiveRoleOverride {
  return pruneOverride({
    adapterType: asOptionalString(source.adapterType),
    recommendedModel: asOptionalString(source.recommendedModel),
    fallbackAdapterType: asOptionalString(source.fallbackAdapterType),
    fallbackModel: asOptionalString(source.fallbackModel),
    toolsConfig: source.toolsConfig === undefined ? undefined : source.toolsConfig,
  });
}

function pruneOverride(override: HiveRoleOverride): HiveRoleOverride {
  const out: HiveRoleOverride = {};
  for (const [key, value] of Object.entries(override) as Array<[keyof HiveRoleOverride, unknown]>) {
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") {
      out[key] = null as never;
    } else {
      out[key] = value as never;
    }
  }
  return out;
}

function asOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
