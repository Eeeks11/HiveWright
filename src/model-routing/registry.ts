import type { Sql } from "postgres";
import type {
  ModelCapabilityAxis,
  ModelCapabilityConfidence,
  ModelCapabilityScoreView,
} from "@/model-catalog/capability-scores";
import {
  canonicalModelIdForAdapter,
  collapseConfiguredModelAliasRows,
} from "@/model-health/model-identity";
import { classifyProbeFreshness, getModelHealthProbePolicy } from "@/model-health/probe-policy";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { getCanonicalOllamaHealthBaseUrl } from "@/ollama/endpoint";
import { loadModelHealthByIdentity } from "@/model-health/stored-health";
import { isUnsupportedModelDiscoveryCandidate } from "@/model-discovery/unsupported-models";
import {
  loadModelRoutingPolicyState,
  saveModelRoutingPolicy,
  type ModelRoutingPolicyState,
} from "./policy";
import { MODEL_ROUTING_PROFILES } from "./profiles";
import { classifyModelRoutingTask } from "./task-classifier";
import type { ModelRoutingOutcomeScore, ModelRoutingPolicy } from "./selector";

type RegistryHealthStatus = "healthy" | "unknown" | "unhealthy";

interface HiveModelRegistryRow {
  id: string;
  provider: string;
  model_id: string;
  adapter_type: string;
  credential_id: string | null;
  credential_name: string | null;
  credential_fingerprint: string | null;
  capabilities: string[];
  fallback_priority: number;
  enabled: boolean;
  cost_per_input_token: string | null;
  cost_per_output_token: string | null;
  benchmark_quality_score: string | number | null;
  routing_cost_score: string | number | null;
}

type CapabilityScoreRow = {
  model_catalog_id: string | null;
  provider: string;
  adapter_type: string;
  model_id: string;
  canonical_model_id: string;
  axis: ModelCapabilityAxis;
  score: string | number;
  raw_score: string | null;
  source: string;
  source_url: string;
  benchmark_name: string;
  model_version_matched: string;
  confidence: ModelCapabilityConfidence;
  updated_at: Date | null;
};

type OutcomeTaskRow = {
  id: string;
  assigned_to: string;
  role_type: string | null;
  title: string;
  brief: string;
  acceptance_criteria: string | null;
  retry_count: number | null;
  doctor_attempts: number | null;
  status: string;
  adapter_used: string | null;
  model_used: string;
  explicit_rating: string | number | null;
  implicit_score: string | number | null;
};

export interface ModelRoutingRegistryRow {
  id: string;
  routeKey: string;
  provider: string;
  adapterType: string;
  model: string;
  credentialId: string | null;
  credentialName: string | null;
  credentialFingerprint: string | null;
  healthFingerprint: string;
  capabilities: string[];
  fallbackPriority: number;
  hiveModelEnabled: boolean;
  routingEnabled: boolean;
  roleSlugs: string[];
  status: RegistryHealthStatus;
  qualityScore: number | null;
  costScore: number | null;
  capabilityScores: ModelCapabilityScoreView[];
  costPerInputToken: string | null;
  costPerOutputToken: string | null;
  local: boolean;
  lastProbedAt: Date | null;
  lastFailedAt: Date | null;
  lastFailureReason: string | null;
  failureClass: string | null;
  failureMessage: string | null;
  nextProbeAt: Date | null;
  probeFreshness: "unknown" | "fresh" | "due";
  probeMode: "automatic" | "on_demand";
  latencyMs: number | null;
  sampleCostUsd: number | null;
  outcomeScores?: Partial<Record<keyof typeof MODEL_ROUTING_PROFILES, ModelRoutingOutcomeScore>>;
}

export interface ModelRoutingView {
  models: ModelRoutingRegistryRow[];
  policy: ModelRoutingPolicy;
  basePolicyState: ModelRoutingPolicyState;
  profiles: typeof MODEL_ROUTING_PROFILES;
}

export function routeKeyForModel(input: {
  provider: string;
  adapterType: string;
  model: string;
}): string {
  return `${input.provider}:${input.adapterType}:${input.model}`;
}

export async function loadModelRoutingView(
  sql: Sql,
  hiveId: string,
): Promise<ModelRoutingView> {
  let basePolicyState = await loadModelRoutingPolicyState(sql, hiveId);
  const basePolicy = basePolicyState.policy;
  const modelRows = await sql<HiveModelRegistryRow[]>`
    SELECT
      hm.id,
      hm.provider,
      hm.model_id,
      hm.adapter_type,
      hm.credential_id,
      c.name AS credential_name,
      c.fingerprint AS credential_fingerprint,
      hm.capabilities,
      hm.fallback_priority,
      hm.enabled,
      hm.cost_per_input_token,
      hm.cost_per_output_token,
      hm.benchmark_quality_score,
      hm.routing_cost_score
    FROM hive_models hm
    LEFT JOIN credentials c ON c.id = hm.credential_id
    WHERE hm.hive_id = ${hiveId}
    ORDER BY hm.fallback_priority ASC, hm.created_at ASC
  `;

  const collapsedRows = collapseConfiguredModelAliasRows(modelRows);
  const capabilityScoresByModel = await loadCapabilityScoresByModel(sql, collapsedRows);
  const outcomeScoresByModel = await loadOutcomeScoresByModel(sql, hiveId, collapsedRows);

  const models: ModelRoutingRegistryRow[] = [];
  for (const row of collapsedRows) {
    if (isUnsupportedModelDiscoveryCandidate(row.adapter_type, row.model_id)) {
      continue;
    }

    const healthFingerprint = row.credential_fingerprint ?? createRuntimeCredentialFingerprint({
      provider: row.provider,
      adapterType: row.adapter_type,
      baseUrl: getCanonicalOllamaHealthBaseUrl({ provider: row.provider, adapterType: row.adapter_type }),
    });
    const health = await loadModelHealthByIdentity(sql, {
      fingerprint: healthFingerprint,
      adapterType: row.adapter_type,
      modelId: row.model_id,
    });
    const routeKey = routeKeyForModel({
      provider: row.provider,
      adapterType: row.adapter_type,
      model: row.model_id,
    });
    const override = basePolicy?.routeOverrides?.[routeKey];
    const failure = parseFailureReason(health?.last_failure_reason ?? null);
    const probeMode = getModelHealthProbePolicy({
      provider: row.provider,
      adapterType: row.adapter_type,
      modelId: canonicalModelIdForAdapter(row.adapter_type, row.model_id),
      capabilities: row.capabilities ?? [],
      sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
    }).mode;

    models.push({
      id: row.id,
      routeKey,
      provider: row.provider,
      adapterType: row.adapter_type,
      model: row.model_id,
      credentialId: row.credential_id,
      credentialName: row.credential_name,
      credentialFingerprint: row.credential_fingerprint,
      healthFingerprint,
      capabilities: row.capabilities ?? [],
      fallbackPriority: row.fallback_priority,
      hiveModelEnabled: row.enabled,
      routingEnabled: override?.enabled ?? row.enabled,
      roleSlugs: override?.roleSlugs ?? [],
      status: normalizeHealthStatus(health?.status),
      qualityScore: asNullableNumber(row.benchmark_quality_score),
      costScore: asNullableNumber(row.routing_cost_score),
      capabilityScores: capabilityScoresByModel.get(capabilityScoreKey(row)) ?? [],
      costPerInputToken: row.cost_per_input_token,
      costPerOutputToken: row.cost_per_output_token,
      local: isLocalModel(row.provider, row.adapter_type),
      lastProbedAt: health?.last_probed_at ?? null,
      lastFailedAt: health?.last_failed_at ?? null,
      lastFailureReason: health?.last_failure_reason ?? null,
      failureClass: failure.failureClass,
      failureMessage: failure.message,
      nextProbeAt: health?.next_probe_at ?? null,
      probeFreshness: classifyProbeFreshness(health?.next_probe_at ?? null, new Date()),
      probeMode,
      latencyMs: health?.latency_ms ?? null,
      sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
      outcomeScores: outcomeScoresByModel.get(capabilityScoreKey(row)) ?? {},
    });
  }

  const canonicalCandidates = buildCanonicalRouteCandidates(models);
  const persistedPolicy = prunePolicyToCanonicalRoutes(basePolicyState.policy, models, canonicalCandidates);
  if (!sameModelRoutingPolicy(basePolicyState.policy, persistedPolicy)) {
    await saveModelRoutingPolicy(sql, hiveId, persistedPolicy);
    basePolicyState = {
      ...basePolicyState,
      source: "hive",
      policy: persistedPolicy,
    };
  }

  const effectiveBasePolicy = basePolicyState.policy;
  const canonicalCandidatesByRoute = new Map(
    (effectiveBasePolicy?.candidates ?? []).map((candidate) => [
      `${candidate.adapterType}:${candidate.model}`,
      candidate,
    ]),
  );

  return {
    models,
    policy: {
      preferences: effectiveBasePolicy?.preferences,
      routeOverrides: effectiveBasePolicy?.routeOverrides,
      roleRoutes: effectiveBasePolicy?.roleRoutes,
      candidates: models.map((model) => {
        const canonicalCandidate = canonicalCandidatesByRoute.get(`${model.adapterType}:${model.model}`);
        return {
          adapterType: model.adapterType,
          model: model.model,
          enabled: canonicalCandidate?.enabled ?? (model.hiveModelEnabled && model.routingEnabled),
          status: canonicalCandidate?.status ?? model.status,
          probeFreshness: model.probeFreshness === "unknown" ? undefined : model.probeFreshness,
          qualityScore: model.qualityScore ?? undefined,
          costScore: model.costScore ?? undefined,
          capabilityScores: model.capabilityScores,
          outcomeScores: model.outcomeScores,
          local: model.local,
          roleSlugs: model.roleSlugs.length > 0 ? model.roleSlugs : undefined,
          canonicalRouteSet: canonicalCandidate?.canonicalRouteSet,
        };
      }),
    },
    basePolicyState,
    profiles: MODEL_ROUTING_PROFILES,
  };
}

function buildCanonicalRouteCandidates(models: ModelRoutingRegistryRow[]): ModelRoutingPolicy["candidates"] {
  return models.map((model) => {
    const membership = canonicalMembershipForModel(model);
    const enabled = membership === "included" || membership === "role_scoped";
    return {
      adapterType: model.adapterType,
      model: model.model,
      enabled,
      status: enabled ? undefined : "disabled" as const,
      roleSlugs: model.roleSlugs.length > 0 ? model.roleSlugs : undefined,
      local: model.local,
      canonicalRouteSet: {
        source: "configured_route_inventory" as const,
        membership,
        routeKey: model.routeKey,
        reason: canonicalMembershipReason(model, membership),
      },
    };
  });
}

function prunePolicyToCanonicalRoutes(
  current: ModelRoutingPolicy | null,
  models: ModelRoutingRegistryRow[],
  canonicalCandidates: ModelRoutingPolicy["candidates"],
): ModelRoutingPolicy {
  const canonicalRouteKeys = new Set(models.map((model) => model.routeKey));
  const canonicalModels = new Set(canonicalCandidates.map((candidate) => candidate.model));

  const routeOverrides = pruneRouteOverrides(current?.routeOverrides, canonicalRouteKeys);
  const roleRoutes = pruneRoleRoutes(current?.roleRoutes, canonicalModels);

  return {
    preferences: current?.preferences,
    routeOverrides,
    roleRoutes,
    candidates: canonicalCandidates,
  };
}

function pruneRouteOverrides(
  routeOverrides: ModelRoutingPolicy["routeOverrides"],
  canonicalRouteKeys: Set<string>,
): ModelRoutingPolicy["routeOverrides"] {
  if (!routeOverrides) return undefined;
  const retained: NonNullable<ModelRoutingPolicy["routeOverrides"]> = {};
  for (const [routeKey, override] of Object.entries(routeOverrides)) {
    if (canonicalRouteKeys.has(routeKey)) retained[routeKey] = override;
  }
  return Object.keys(retained).length > 0 ? retained : undefined;
}

function pruneRoleRoutes(
  roleRoutes: ModelRoutingPolicy["roleRoutes"],
  canonicalModels: Set<string>,
): ModelRoutingPolicy["roleRoutes"] {
  if (!roleRoutes) return undefined;
  const retained: NonNullable<ModelRoutingPolicy["roleRoutes"]> = {};
  for (const [roleSlug, route] of Object.entries(roleRoutes)) {
    const candidateModels = (route.candidateModels ?? []).filter((model) => canonicalModels.has(model));
    if (candidateModels.length > 0) retained[roleSlug] = { candidateModels };
  }
  return Object.keys(retained).length > 0 ? retained : undefined;
}

function sameModelRoutingPolicy(
  current: ModelRoutingPolicy | null,
  next: ModelRoutingPolicy,
): boolean {
  if (!sameCanonicalRouteCandidates(current?.candidates ?? [], next.candidates)) return false;
  return JSON.stringify(current?.preferences ?? null) === JSON.stringify(next.preferences ?? null) &&
    JSON.stringify(current?.routeOverrides ?? null) === JSON.stringify(next.routeOverrides ?? null) &&
    JSON.stringify(current?.roleRoutes ?? null) === JSON.stringify(next.roleRoutes ?? null);
}

function canonicalMembershipForModel(model: ModelRoutingRegistryRow): NonNullable<ModelRoutingPolicy["candidates"][number]["canonicalRouteSet"]>["membership"] {
  if (isRetiredAnthropicClaudeCodeRoute(model)) return "excluded";
  if (!model.hiveModelEnabled || !model.routingEnabled) return "intentionally_disabled";
  if (isCodexScopeBlockedRoute(model)) return "excluded";
  if (model.probeMode === "on_demand") return "excluded";
  if (model.roleSlugs.length > 0) return "role_scoped";
  return "included";
}

function canonicalMembershipReason(
  model: ModelRoutingRegistryRow,
  membership: NonNullable<ModelRoutingPolicy["candidates"][number]["canonicalRouteSet"]>["membership"],
): string {
  switch (membership) {
    case "intentionally_disabled":
      return !model.hiveModelEnabled
        ? "Hive model route is disabled in the configured inventory."
        : "Route override intentionally disables this configured route.";
    case "excluded":
      if (isRetiredAnthropicClaudeCodeRoute(model)) {
        return "Disabled Anthropic claude-code routes are retired from the canonical automatic route pool unless an owner explicitly re-enables one with a support/recovery path.";
      }
      if (isCodexScopeBlockedRoute(model)) {
        return "OpenAI Codex health probes report a non-retryable scope/model-entitlement failure, so this route is retained only as excluded inventory rather than an automatic candidate.";
      }
      return "Route uses on-demand probe policy, so it is excluded from the canonical automatic route pool.";
    case "role_scoped":
      return "Route is included only for the declared role scope.";
    case "included":
      return "Route is included in the canonical automatic route pool.";
  }
}

function isRetiredAnthropicClaudeCodeRoute(model: ModelRoutingRegistryRow): boolean {
  return model.provider.trim().toLowerCase() === "anthropic" &&
    model.adapterType.trim().toLowerCase() === "claude-code" &&
    (!model.hiveModelEnabled || !model.routingEnabled);
}

function isCodexScopeBlockedRoute(model: ModelRoutingRegistryRow): boolean {
  return model.provider.trim().toLowerCase() === "openai" &&
    model.adapterType.trim().toLowerCase() === "codex" &&
    model.failureClass === "scope";
}

function sameCanonicalRouteCandidates(
  current: ModelRoutingPolicy["candidates"],
  next: ModelRoutingPolicy["candidates"],
): boolean {
  return JSON.stringify(current.map(canonicalCandidateComparable)) ===
    JSON.stringify(next.map(canonicalCandidateComparable));
}

function canonicalCandidateComparable(candidate: ModelRoutingPolicy["candidates"][number]) {
  return {
    adapterType: candidate.adapterType,
    model: candidate.model,
    enabled: candidate.enabled,
    status: candidate.status,
    roleSlugs: candidate.roleSlugs ?? [],
    local: candidate.local,
    canonicalRouteSet: candidate.canonicalRouteSet ?? null,
  };
}

async function loadOutcomeScoresByModel(
  sql: Sql,
  hiveId: string,
  rows: HiveModelRegistryRow[],
): Promise<Map<string, Partial<Record<keyof typeof MODEL_ROUTING_PROFILES, ModelRoutingOutcomeScore>>>> {
  if (rows.length === 0) return new Map();
  const candidateKeys = new Map(rows.map((row) => [
    `${row.adapter_type}:${canonicalModelIdForAdapter(row.adapter_type, row.model_id)}`,
    capabilityScoreKey(row),
  ]));
  const taskRows = await sql<OutcomeTaskRow[]>`
    SELECT
      t.id,
      t.assigned_to,
      rt.type AS role_type,
      t.title,
      t.brief,
      t.acceptance_criteria,
      t.retry_count,
      t.doctor_attempts,
      t.status,
      t.adapter_used,
      t.model_used,
      AVG(s.rating / 10.0) FILTER (
        WHERE s.source = 'explicit_owner_feedback'
          AND s.rating IS NOT NULL
          AND s.is_qa_fixture = false
      )::float AS explicit_rating,
      CASE WHEN SUM(s.confidence) FILTER (
        WHERE s.source = 'implicit_ea'
          AND s.is_qa_fixture = false
      ) > 0 THEN (
        SUM((CASE s.signal_type WHEN 'positive' THEN 1.0 WHEN 'neutral' THEN 0.5 ELSE 0.0 END) * s.confidence)
          FILTER (WHERE s.source = 'implicit_ea' AND s.is_qa_fixture = false)
        / SUM(s.confidence) FILTER (WHERE s.source = 'implicit_ea' AND s.is_qa_fixture = false)
      )::float ELSE NULL END AS implicit_score
    FROM tasks t
    LEFT JOIN role_templates rt ON rt.slug = t.assigned_to
    LEFT JOIN task_quality_signals s ON s.task_id = t.id AND s.hive_id = t.hive_id
    WHERE t.hive_id = ${hiveId}::uuid
      AND t.model_used IS NOT NULL
      AND t.status IN ('completed','failed','unresolvable')
      AND COALESCE(t.completed_at, t.updated_at, t.created_at) > NOW() - INTERVAL '60 days'
    GROUP BY t.id, rt.type
  `;

  const aggregate = new Map<string, { total: number; count: number }>();
  for (const task of taskRows) {
    const adapter = task.adapter_used?.trim();
    if (!adapter) continue;
    const modelKey = `${adapter}:${canonicalModelIdForAdapter(adapter, task.model_used)}`;
    const candidateKey = candidateKeys.get(modelKey);
    if (!candidateKey) continue;
    const classification = classifyModelRoutingTask({
      roleSlug: task.assigned_to,
      roleType: task.role_type,
      taskTitle: task.title,
      taskBrief: task.brief,
      acceptanceCriteria: task.acceptance_criteria,
      retryCount: task.retry_count,
    });
    const key = `${candidateKey}\u0000${classification.profile}`;
    const current = aggregate.get(key) ?? { total: 0, count: 0 };
    current.total += scoreOutcomeTask(task);
    current.count += 1;
    aggregate.set(key, current);
  }

  const byModel = new Map<string, Partial<Record<keyof typeof MODEL_ROUTING_PROFILES, ModelRoutingOutcomeScore>>>();
  for (const [key, value] of aggregate.entries()) {
    const [candidateKey, profile] = key.split("\u0000") as [string, keyof typeof MODEL_ROUTING_PROFILES];
    if (value.count <= 0) continue;
    const score = Math.round((value.total / value.count) * 1000) / 1000;
    const current = byModel.get(candidateKey) ?? {};
    current[profile] = { score, sampleSize: value.count };
    byModel.set(candidateKey, current);
  }
  return byModel;
}

function scoreOutcomeTask(task: OutcomeTaskRow): number {
  const explicit = asNullableNumber(task.explicit_rating);
  if (explicit !== null) return clamp01(explicit);
  const implicit = asNullableNumber(task.implicit_score);
  if (implicit !== null) return clamp01(implicit);
  if (task.status !== "completed") return 0.1;
  const retryPenalty = Math.min(0.3, Number(task.retry_count ?? 0) * 0.08);
  const doctorPenalty = Math.min(0.3, Number(task.doctor_attempts ?? 0) * 0.1);
  return clamp01(0.75 - retryPenalty - doctorPenalty);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

async function loadCapabilityScoresByModel(
  sql: Sql,
  rows: HiveModelRegistryRow[],
): Promise<Map<string, ModelCapabilityScoreView[]>> {
  if (rows.length === 0) return new Map();

  const keys = [...new Map(rows.map((row) => {
    const key = capabilityScoreKey(row);
    return [key, {
      key,
      provider: row.provider,
      adapterType: row.adapter_type,
      canonicalModelId: canonicalModelIdForAdapter(row.adapter_type, row.model_id),
    }];
  })).values()];
  const keySet = new Set(keys.map((key) => key.key));
  const keyConditions = keys.map((key) => sql`
    (
      provider = ${key.provider}
      AND adapter_type = ${key.adapterType}
      AND canonical_model_id = ${key.canonicalModelId}
    )
  `);
  let keyFilter = keyConditions[0];
  for (const condition of keyConditions.slice(1)) {
    keyFilter = sql`${keyFilter} OR ${condition}`;
  }

  const scoreRows = await sql<CapabilityScoreRow[]>`
    SELECT
      model_catalog_id,
      provider,
      adapter_type,
      model_id,
      canonical_model_id,
      axis,
      score,
      raw_score,
      source,
      source_url,
      benchmark_name,
      model_version_matched,
      confidence,
      updated_at
    FROM model_capability_scores
    WHERE ${keyFilter}
    ORDER BY
      axis ASC,
      CASE confidence
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 1
        ELSE 0
      END DESC,
      updated_at DESC NULLS LAST,
      source ASC,
      benchmark_name ASC
  `;

  const scoresByModel = new Map<string, ModelCapabilityScoreView[]>();
  for (const row of scoreRows) {
    const key = capabilityScoreKey({
      provider: row.provider,
      adapter_type: row.adapter_type,
      model_id: row.canonical_model_id,
    });
    if (!keySet.has(key)) continue;

    const score = capabilityScoreViewFromRow(row);
    scoresByModel.set(key, [...(scoresByModel.get(key) ?? []), score]);
  }

  for (const [key, scores] of scoresByModel) {
    scoresByModel.set(key, scores.sort(compareCapabilityScoreViewsForOutput));
  }
  return scoresByModel;
}

function capabilityScoreViewFromRow(row: CapabilityScoreRow): ModelCapabilityScoreView {
  return {
    modelCatalogId: row.model_catalog_id,
    provider: row.provider,
    adapterType: row.adapter_type,
    modelId: row.model_id,
    canonicalModelId: row.canonical_model_id,
    axis: row.axis,
    score: asNullableNumber(row.score) ?? 0,
    rawScore: row.raw_score,
    source: row.source,
    sourceUrl: row.source_url,
    benchmarkName: row.benchmark_name,
    modelVersionMatched: row.model_version_matched,
    confidence: row.confidence,
    updatedAt: row.updated_at,
  };
}

function compareCapabilityScoreViewsForOutput(
  a: ModelCapabilityScoreView,
  b: ModelCapabilityScoreView,
): number {
  return a.axis.localeCompare(b.axis) ||
    a.source.localeCompare(b.source) ||
    a.benchmarkName.localeCompare(b.benchmarkName);
}


function capabilityScoreKey(input: {
  provider: string;
  adapter_type: string;
  model_id: string;
}): string {
  return [
    input.provider.trim().toLowerCase(),
    input.adapter_type.trim().toLowerCase(),
    canonicalModelIdForAdapter(input.adapter_type, input.model_id).toLowerCase(),
  ].join(":");
}

function normalizeHealthStatus(value: string | null | undefined): RegistryHealthStatus {
  if (value === "healthy" || value === "unhealthy") return value;
  return "unknown";
}

function asNullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isLocalModel(provider: string, adapterType: string): boolean {
  return provider.trim().toLowerCase() === "local" ||
    adapterType.trim().toLowerCase() === "ollama";
}

function parseFailureReason(value: string | null): {
  failureClass: string | null;
  message: string | null;
} {
  if (!value) return { failureClass: null, message: null };
  try {
    const parsed = JSON.parse(value) as { failureClass?: unknown; message?: unknown };
    return {
      failureClass: typeof parsed.failureClass === "string" ? parsed.failureClass : null,
      message: typeof parsed.message === "string" ? parsed.message : value,
    };
  } catch {
    return { failureClass: null, message: value };
  }
}
