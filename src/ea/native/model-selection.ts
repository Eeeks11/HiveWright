import type { Sql } from "postgres";
import { canonicalModelIdForAdapter } from "@/model-health/model-identity";
import { checkModelSpawnHealth } from "@/model-health/spawn-gate";
import { normalizeEaModel } from "./runner";

interface EaConnectorInstallRow {
  connectorSlug: string;
  createdAt: Date;
  config: Record<string, unknown> | null;
}

/**
 * Resolve the EA model override for a hive.
 *
 * We only honor the configured model when the corresponding model row is
 * present and the latest probe is fresh/healthy. Otherwise the EA keeps
 * using the runtime default so a stale or missing model cannot pin the
 * assistant to an unavailable release.
 */
export async function loadGovernedEaModel(
  sql: Sql,
  hiveId: string,
  connectorSlugs: string[] = ["ea-discord"],
): Promise<string | undefined> {
  const installs = await sql<EaConnectorInstallRow[]>`
    SELECT connector_slug AS "connectorSlug",
           created_at AS "createdAt",
           config
    FROM connector_installs
    WHERE hive_id = ${hiveId}
      AND status = 'active'
  `;

  const slugOrder = new Map(connectorSlugs.map((slug, index) => [slug, index] as const));

  for (const install of installs.sort((a, b) => {
    const aSlug = a.connectorSlug;
    const bSlug = b.connectorSlug;
    const slugDelta = (slugOrder.get(aSlug) ?? Number.POSITIVE_INFINITY) -
      (slugOrder.get(bSlug) ?? Number.POSITIVE_INFINITY);
    if (slugDelta !== 0) return slugDelta;
    return b.createdAt.getTime() - a.createdAt.getTime();
  })) {
    const connectorSlug = install.connectorSlug;
    if (!connectorSlugs.includes(connectorSlug)) continue;
    const config = install.config ?? {};
    const configuredModel = typeof config.model === "string" ? config.model : null;
    const model = await resolveGovernedEaModel(sql, hiveId, configuredModel);
    if (model) return model;
  }

  return undefined;
}

export async function resolveGovernedEaModel(
  sql: Sql,
  hiveId: string,
  configuredModel: string | null | undefined,
): Promise<string | undefined> {
  const model = normalizeEaModel(configuredModel ?? undefined);
  if (!model) return undefined;

  const candidates = [
    canonicalModelIdForAdapter("codex", model),
    model,
  ];
  const checked = new Set<string>();
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate || checked.has(normalizedCandidate.toLowerCase())) continue;
    checked.add(normalizedCandidate.toLowerCase());

    const decision = await checkModelSpawnHealth(sql, {
      hiveId,
      adapterType: "codex",
      modelId: normalizedCandidate,
    });
    if (decision.canRun) return normalizedCandidate;
  }

  return undefined;
}
