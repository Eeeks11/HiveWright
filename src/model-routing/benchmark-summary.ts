import type { RuntimeRouteDriftReport } from "@/operations/runtime-drift-report";
import type { ModelRoutingPolicy, ResolvedModelRoute } from "./selector";

export interface PromptfooResultSummary {
  source: "promptfoo";
  total: number;
  passed: number;
  failed: number;
  passRate: number | null;
}

export interface GatedBenchmarkRecommendation {
  adapterType: string;
  model: string;
  status: "usable" | "stale_warning" | "disabled";
  warnings: string[];
}

export interface GatedBenchmarkSummary {
  benchmark: PromptfooResultSummary;
  driftStatus: RuntimeRouteDriftReport["status"];
  warnings: string[];
  recommendations: GatedBenchmarkRecommendation[];
}

export function parsePromptfooResultSummary(value: unknown): PromptfooResultSummary {
  const root = asRecord(value);
  const results = Array.isArray(root?.results) ? root.results : [];
  const stats = asRecord(root?.stats) ?? asRecord(root?.summary);
  const total = asCount(stats?.total) ?? results.length;
  const failuresFromStats = asCount(stats?.failures ?? stats?.failed);
  const passedFromStats = asCount(stats?.successes ?? stats?.passed);
  const passed = passedFromStats ?? results.filter(isPassingPromptfooResult).length;
  const failed = failuresFromStats ?? Math.max(0, total - passed);
  return {
    source: "promptfoo",
    total,
    passed,
    failed,
    passRate: total > 0 ? passed / total : null,
  };
}

export function buildGatedBenchmarkSummary(input: {
  promptfooResult: unknown;
  routeDrift: RuntimeRouteDriftReport;
  policy: ModelRoutingPolicy;
  explicitRoute?: Pick<ResolvedModelRoute, "adapterType" | "model" | "source"> | null;
}): GatedBenchmarkSummary {
  const benchmark = parsePromptfooResultSummary(input.promptfooResult);
  const driftWarnings = input.routeDrift.status === "in_sync"
    ? []
    : [
        "Runtime routing provenance is stale or drifted; benchmark-derived recommendations require operator review before use.",
        ...input.routeDrift.driftReasons,
      ];

  const explicitKey = input.explicitRoute?.source === "manual_role" && input.explicitRoute.adapterType && input.explicitRoute.model
    ? routeKey(input.explicitRoute.adapterType, input.explicitRoute.model)
    : null;

  const recommendations = input.policy.candidates.map((candidate): GatedBenchmarkRecommendation => {
    const disabled = candidate.enabled === false || candidate.status === "disabled";
    const isExplicit = explicitKey === routeKey(candidate.adapterType, candidate.model);
    const staleWarning = driftWarnings.length > 0 && !isExplicit;
    return {
      adapterType: candidate.adapterType,
      model: candidate.model,
      status: disabled ? "disabled" : staleWarning ? "stale_warning" : "usable",
      warnings: disabled
        ? ["Candidate is disabled in hive model routing settings and must not be re-enabled by benchmark output."]
        : staleWarning
          ? driftWarnings
          : [],
    };
  });

  return {
    benchmark,
    driftStatus: input.routeDrift.status,
    warnings: driftWarnings,
    recommendations,
  };
}

function isPassingPromptfooResult(value: unknown): boolean {
  const row = asRecord(value);
  if (!row) return false;
  if (row.success === true || row.pass === true) return true;
  if (row.success === false || row.pass === false) return false;
  if (typeof row.status === "string") return ["pass", "passed", "success"].includes(row.status.toLowerCase());
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function routeKey(adapterType: string, model: string): string {
  return `${adapterType.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
}
