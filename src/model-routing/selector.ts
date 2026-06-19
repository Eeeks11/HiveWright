import type { ModelCapabilityScoreView } from "@/model-catalog/capability-scores";
import { MODEL_ROUTING_PROFILES, type ModelRoutingProfile } from "./profiles";
import {
  classifyModelRoutingTask,
  type ModelRoutingTaskContext,
} from "./task-classifier";

export const AUTO_MODEL_ROUTE = "auto";

export type ModelRouteSource = "manual_role" | "auto_policy" | "auto_unavailable";

export interface ModelRoutingCandidate {
  adapterType: string;
  model: string;
  enabled?: boolean;
  status?: "healthy" | "unknown" | "unhealthy" | "degraded" | "disabled";
  probeFreshness?: "fresh" | "due" | "never";
  qualityScore?: number;
  costScore?: number;
  capabilityScores?: ModelCapabilityScoreView[];
  local?: boolean;
  roleSlugs?: string[];
  roleTypes?: string[];
  outcomeScores?: Partial<Record<ModelRoutingProfile, ModelRoutingOutcomeScore>>;
  canonicalRouteSet?: {
    source: "configured_route_inventory";
    membership: "included" | "excluded" | "role_scoped" | "intentionally_disabled";
    routeKey?: string;
    reason?: string;
  };
}

export interface ModelRoutingOutcomeScore {
  score: number;
  sampleSize: number;
}

export interface ModelRoutingOverride {
  enabled?: boolean;
  roleSlugs?: string[];
}

export interface ModelRoutingPolicy {
  preferences?: {
    costQualityBalance?: number;
  };
  routeOverrides?: Record<string, ModelRoutingOverride>;
  roleRoutes?: Record<string, {
    candidateModels?: string[];
  }>;
  candidates: ModelRoutingCandidate[];
}

export interface ResolveConfiguredModelRouteInput {
  roleSlug: string;
  roleType: string | null;
  manualAdapterType: string | null;
  manualModel: string | null;
  policy: ModelRoutingPolicy | null;
  taskContext?: Omit<ModelRoutingTaskContext, "roleSlug" | "roleType">;
}

export interface ResolvedModelRoute {
  adapterType: string | null;
  model: string | null;
  source: ModelRouteSource;
  reason: string;
  profile?: ModelRoutingProfile;
  explanation?: string;
  scoreBreakdown?: {
    selectedScore: number;
    candidates: Array<{
      model: string;
      adapterType: string;
      score: number;
      capabilityFit: number;
      costScore: number;
      costKnown: boolean;
      speedScore: number;
      selected: boolean;
      missingAxes: string[];
      lowConfidenceAxes: string[];
      sourceDisagreements: string[];
      selectedSources: Array<{
        axis: string;
        source: string;
        benchmarkName: string;
        score: number;
        confidence: string;
        modelVersionMatched: string;
      }>;
      outcomeScore?: number;
      outcomeSampleSize?: number;
    }>;
  };
}

export function resolveConfiguredModelRoute(
  input: ResolveConfiguredModelRouteInput,
): ResolvedModelRoute {
  const manualAdapterType = normalizeManualValue(input.manualAdapterType);
  const manualModel = normalizeManualValue(input.manualModel);
  const wantsAuto = manualAdapterType === null || manualModel === null;

  if (!wantsAuto && manualAdapterType && manualModel) {
    return {
      adapterType: manualAdapterType,
      model: manualModel,
      source: "manual_role",
      reason: "role has explicit adapter and model",
    };
  }

  const policy = input.policy;
  if (!policy?.candidates?.length) {
    return {
      adapterType: null,
      model: null,
      source: "auto_unavailable",
      reason: "auto model routing has no enabled candidates",
    };
  }

  const costQualityBalance = normalizeRoutingBalance(policy.preferences?.costQualityBalance);
  const { qualityWeight, costWeight } = weightsForRoutingBalance(costQualityBalance);
  const priorityReason = `routing priority ${routingPriorityLabel(costQualityBalance)}`;
  const costTieBreakerEnabled = costQualityBalance < 100;
  const allowlist = new Set(policy.roleRoutes?.[input.roleSlug]?.candidateModels ?? []);
  const classification = classifyModelRoutingTask({
    roleSlug: input.roleSlug,
    roleType: input.roleType,
    ...input.taskContext,
  });
  const profileConfig = MODEL_ROUTING_PROFILES[classification.profile];

  const scoredCandidates = policy.candidates
    .filter((candidate) => candidate.enabled !== false)
    .filter((candidate) => isCandidateHealthEligible(candidate))
    .filter((candidate) => manualAdapterType === null || candidate.adapterType === manualAdapterType)
    .filter((candidate) => manualModel === null || candidate.model === manualModel)
    .filter((candidate) => allowlist.size === 0 || allowlist.has(candidate.model))
    .filter((candidate) => !candidate.roleSlugs || candidate.roleSlugs.includes(input.roleSlug))
    .filter((candidate) => !candidate.roleTypes || (input.roleType !== null && candidate.roleTypes.includes(input.roleType)))
    .map((candidate) => scoreCandidate(candidate, {
      qualityWeight,
      costWeight,
      profileConfig,
    }));
  const profileFilteredCount = scoredCandidates.filter((candidate) => (
    hasCapabilityScores(candidate.candidate) &&
    candidate.capabilityFit < profileConfig.minimumCapabilityScore
  )).length;
  const ranked = scoredCandidates
    .filter((candidate) => (
      !hasCapabilityScores(candidate.candidate) ||
      candidate.capabilityFit >= profileConfig.minimumCapabilityScore
    ))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const hasCapabilityRankedCandidates = ranked.some((candidate) => hasCapabilityScores(candidate.candidate));
  const closeScoreWinner = best && hasCapabilityRankedCandidates && costTieBreakerEnabled
    ? ranked
      .filter((candidate) => best.score - candidate.score <= profileConfig.closeScoreDelta)
      .filter((candidate) => best.capabilityFit - candidate.capabilityFit <= profileConfig.closeScoreDelta)
      .sort((a, b) => a.costScore - b.costScore || b.score - a.score)[0]
    : undefined;
  const selectedScore = closeScoreWinner ?? best;
  const selected = selectedScore?.candidate;
  if (!selected) {
    return {
      adapterType: null,
      model: null,
      source: "auto_unavailable",
      reason: profileFilteredCount > 0
        ? `auto model routing has no enabled candidates matching profile capability>=${profileConfig.minimumCapabilityScore} for ${profileConfig.profile}`
        : "auto model routing has no enabled candidates",
    };
  }

  return {
    adapterType: selected.adapterType,
    model: selected.model,
    source: "auto_policy",
    reason: closeScoreWinner && best && closeScoreWinner.candidate !== best.candidate
      ? `selected by auto policy close score for ${profileConfig.profile} with ${priorityReason}`
      : `selected by auto policy for ${profileConfig.profile} with ${priorityReason}`,
    profile: profileConfig.profile,
    explanation: closeScoreWinner && best && closeScoreWinner.candidate !== best.candidate
      ? `Selected ${selected.model} using ${profileConfig.profile} profile because it was within close score delta ${profileConfig.closeScoreDelta} and had lower cost.`
      : selectedScore.outcome
        ? `Selected ${selected.model} using ${profileConfig.profile} profile from ${classification.confidence}-confidence task classification with internal outcome feedback.`
        : `Selected ${selected.model} using ${profileConfig.profile} profile from ${classification.confidence}-confidence task classification.`,
    scoreBreakdown: {
      selectedScore: selectedScore.score,
      candidates: ranked.map((candidate) => ({
        model: candidate.candidate.model,
        adapterType: candidate.candidate.adapterType,
        score: candidate.score,
        capabilityFit: candidate.capabilityFit,
        costScore: candidate.costScore,
        costKnown: candidate.costKnown,
        speedScore: candidate.speedScore,
        selected: candidate.candidate === selected,
        missingAxes: candidate.missingAxes,
        lowConfidenceAxes: candidate.lowConfidenceAxes,
        sourceDisagreements: candidate.sourceDisagreements,
        selectedSources: candidate.selectedSources,
        outcomeScore: candidate.outcome?.score,
        outcomeSampleSize: candidate.outcome?.sampleSize,
      })),
    },
  };
}

function normalizeManualValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === AUTO_MODEL_ROUTE) return null;
  return trimmed;
}

function isCandidateHealthEligible(candidate: ModelRoutingCandidate): boolean {
  if (candidate.probeFreshness && candidate.probeFreshness !== "fresh") return false;
  if (!candidate.status) return true;
  return candidate.status === "healthy" || candidate.status === "degraded";
}

interface ScoreCandidateOptions {
  qualityWeight: number;
  costWeight: number;
  profileConfig: (typeof MODEL_ROUTING_PROFILES)[ModelRoutingProfile];
}

interface ScoredCandidate {
  candidate: ModelRoutingCandidate;
  score: number;
  capabilityFit: number;
  costScore: number;
  costKnown: boolean;
  speedScore: number;
  missingAxes: string[];
  lowConfidenceAxes: string[];
  sourceDisagreements: string[];
  selectedSources: Array<{
    axis: string;
    source: string;
    benchmarkName: string;
    score: number;
    confidence: string;
    modelVersionMatched: string;
  }>;
  outcome?: ModelRoutingOutcomeScore;
}

const UNKNOWN_COST_SCORE = 55;
const SOURCE_DISAGREEMENT_DELTA = 20;

function scoreCandidate(
  candidate: ModelRoutingCandidate,
  options: ScoreCandidateOptions,
): ScoredCandidate {
  const costKnown = candidate.costScore !== undefined && Number.isFinite(Number(candidate.costScore));
  const costScore = costKnown ? Number(candidate.costScore) : UNKNOWN_COST_SCORE;
  const outcome = outcomeScoreForProfile(candidate, options.profileConfig.profile);

  if (!hasCapabilityScores(candidate)) {
    const qualityScore = qualityScoreWithOutcome(candidate.qualityScore, outcome);
    const score =
      qualityScore * options.qualityWeight -
      costScore * options.costWeight;

    return {
      candidate,
      score,
      capabilityFit: qualityScore,
      costScore,
      costKnown,
      speedScore: 0,
      missingAxes: [],
      lowConfidenceAxes: [],
      sourceDisagreements: [],
      selectedSources: [],
      outcome,
    };
  }

  const capabilityScores = groupCapabilityScoresByAxis(candidate.capabilityScores);
  let weightedScore = 0;
  let knownWeight = 0;
  let totalPossibleWeight = 0;
  const missingAxes: string[] = [];
  const lowConfidenceAxes: string[] = [];
  const sourceDisagreements: string[] = [];
  const selectedSources: ScoredCandidate["selectedSources"] = [];

  for (const [axis, weight] of Object.entries(options.profileConfig.weights)) {
    if (axis === "cost") continue;
    totalPossibleWeight += weight;

    const axisScores = capabilityScores.get(axis as ModelCapabilityScoreView["axis"]) ?? [];
    const score = selectPreferredCapabilityScore(axisScores);
    if (!score && axis === "overall_quality" && candidate.qualityScore !== undefined) {
      knownWeight += weight;
      weightedScore += Number(candidate.qualityScore ?? 0) * weight;
      selectedSources.push({
        axis,
        source: "hive_models.benchmark_quality_score",
        benchmarkName: "benchmark_quality_score",
        score: Number(candidate.qualityScore ?? 0),
        confidence: "medium",
        modelVersionMatched: candidate.model,
      });
      continue;
    }
    if (!score) {
      missingAxes.push(axis);
      continue;
    }

    knownWeight += weight;
    if (score.confidence === "low") {
      lowConfidenceAxes.push(axis);
    }
    const disagreement = sourceDisagreementForAxis(axis, axisScores);
    if (disagreement) sourceDisagreements.push(disagreement);
    selectedSources.push({
      axis,
      source: score.source,
      benchmarkName: score.benchmarkName,
      score: Number(score.score ?? 0),
      confidence: score.confidence,
      modelVersionMatched: score.modelVersionMatched,
    });

    weightedScore += capabilityScoreValueForRouting(score) * weight * confidenceMultiplier(score.confidence);
  }

  const rawCapabilityFit = knownWeight > 0 ? weightedScore / knownWeight : 0;
  const coverageRatio = totalPossibleWeight > 0 ? knownWeight / totalPossibleWeight : 0;
  const capabilityFit = qualityScoreWithOutcome(rawCapabilityFit * coverageRatio, outcome);
  const profileCostWeight = options.costWeight === 0 ? 0 : Number(options.profileConfig.weights.cost ?? 0);
  const lowConfidencePenalty = lowConfidenceAxes.length * 4;
  const score =
    capabilityFit * options.qualityWeight -
    costScore * (options.costWeight + profileCostWeight) -
    lowConfidencePenalty;

  return {
    candidate,
    score,
    capabilityFit,
    costScore,
    costKnown,
    speedScore: capabilityScoreValueForRouting(selectPreferredCapabilityScore(capabilityScores.get("speed") ?? [])),
    missingAxes,
    lowConfidenceAxes,
    sourceDisagreements,
    selectedSources,
    outcome,
  };
}

function hasCapabilityScores(
  candidate: ModelRoutingCandidate,
): candidate is ModelRoutingCandidate & { capabilityScores: ModelCapabilityScoreView[] } {
  return Array.isArray(candidate.capabilityScores) && candidate.capabilityScores.length > 0;
}

function groupCapabilityScoresByAxis(
  scores: ModelCapabilityScoreView[],
): Map<ModelCapabilityScoreView["axis"], ModelCapabilityScoreView[]> {
  const grouped = new Map<ModelCapabilityScoreView["axis"], ModelCapabilityScoreView[]>();
  for (const score of scores) {
    grouped.set(score.axis, [...(grouped.get(score.axis) ?? []), score]);
  }
  return grouped;
}

function selectPreferredCapabilityScore(scores: ModelCapabilityScoreView[]): ModelCapabilityScoreView | undefined {
  return [...scores].sort(compareCapabilityScorePreference)[0];
}

function compareCapabilityScorePreference(
  a: ModelCapabilityScoreView,
  b: ModelCapabilityScoreView,
): number {
  return confidenceRank(b.confidence) - confidenceRank(a.confidence) ||
    capabilitySourceRank(b.source) - capabilitySourceRank(a.source) ||
    a.source.localeCompare(b.source) ||
    a.benchmarkName.localeCompare(b.benchmarkName) ||
    Number(b.updatedAt?.getTime() ?? 0) - Number(a.updatedAt?.getTime() ?? 0) ||
    a.benchmarkName.localeCompare(b.benchmarkName);
}

function sourceDisagreementForAxis(axis: string, scores: ModelCapabilityScoreView[]): string | null {
  if (scores.length < 2) return null;
  const values = scores
    .map((score) => capabilityScoreValueForRouting(score))
    .filter((score) => Number.isFinite(score));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < SOURCE_DISAGREEMENT_DELTA) return null;
  const sources = [...new Set(scores.map((score) => `${score.source}/${score.benchmarkName}`))].join(", ");
  return `${axis}: benchmark sources disagree by ${(max - min).toFixed(1)} points (${sources})`;
}

function outcomeScoreForProfile(
  candidate: ModelRoutingCandidate,
  profile: ModelRoutingProfile,
): ModelRoutingOutcomeScore | undefined {
  const score = candidate.outcomeScores?.[profile];
  if (!score || !Number.isFinite(score.score) || !Number.isFinite(score.sampleSize) || score.sampleSize <= 0) {
    return undefined;
  }
  return {
    score: clamp01(score.score),
    sampleSize: Math.max(0, Math.round(score.sampleSize)),
  };
}

function qualityScoreWithOutcome(
  baseQualityScore: number | string | null | undefined,
  outcome: ModelRoutingOutcomeScore | undefined,
): number {
  const base = Number(baseQualityScore ?? 0);
  if (!outcome) return base;
  const confidence = Math.min(1, outcome.sampleSize / 5);
  const outcomeWeight = 0.45 * confidence;
  return base * (1 - outcomeWeight) + (outcome.score * 100) * outcomeWeight;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function capabilitySourceRank(source: string): number {
  const normalized = source.trim().toLowerCase();
  if (normalized === "benchlm") return 4;
  if (normalized === "llm stats") return 3;
  if (normalized === "artificial analysis") return 2;
  return 1;
}

function capabilityScoreValueForRouting(score: ModelCapabilityScoreView | undefined): number {
  if (!score) return 0;
  const value = Number(score.score ?? 0);
  if (!Number.isFinite(value)) return 0;
  if (score.axis !== "speed") return Math.max(0, Math.min(100, value));
  // LLM Stats speed can be raw throughput; route on a bounded score so fast
  // models do not swamp quality axes, while preserving the raw score in
  // selectedSources/rawScore for audit. 250 c/s or higher is treated as 100.
  return Math.max(0, Math.min(100, (value / 250) * 100));
}

function confidenceRank(confidence: ModelCapabilityScoreView["confidence"]): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function confidenceMultiplier(confidence: ModelCapabilityScoreView["confidence"]): number {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.85;
  return 0.6;
}

function normalizeRoutingBalance(costQualityBalance: number | undefined): number {
  return clampRoutingBalance(
    typeof costQualityBalance === "number" && Number.isFinite(costQualityBalance)
      ? costQualityBalance
      : 50,
  );
}

function routingPriorityLabel(costQualityBalance: number): string {
  if (costQualityBalance < 50) {
    return `${costQualityBalance}/100 toward Cost`;
  }
  if (costQualityBalance === 100) {
    return "100/100 Pure Quality";
  }
  if (costQualityBalance > 50) {
    return `${costQualityBalance}/100 toward Quality`;
  }
  return "50/100 Balanced";
}

function weightsForRoutingBalance(
  costQualityBalance: number,
): { qualityWeight: number; costWeight: number } {
  const balance = costQualityBalance / 100;

  return {
    qualityWeight: 0.25 + balance * 1.75,
    costWeight: costQualityBalance === 100 ? 0 : 2 - balance * 1.75,
  };
}

function clampRoutingBalance(value: number): number {
  return Math.max(0, Math.min(100, value));
}
