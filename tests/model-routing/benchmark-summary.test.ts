import { describe, expect, it } from "vitest";
import { buildGatedBenchmarkSummary, parsePromptfooResultSummary } from "@/model-routing/benchmark-summary";
import type { RuntimeRouteDriftReport } from "@/operations/runtime-drift-report";
import { resolveConfiguredModelRoute, type ModelRoutingPolicy } from "@/model-routing/selector";

const drifted: RuntimeRouteDriftReport = {
  status: "drift",
  declaredCandidates: 0,
  explicitDeclaredCandidates: 0,
  runtimeProjectedCandidates: 2,
  projectedInventoryBasis: "usable_runtime_routes",
  inventoryExpectation: "fixed_inventory_unconfigured",
  inventoryJustification: "No explicit policy candidates or configured hive model routes exist.",
  blockedRoutes: 0,
  quarantinedRoutes: 0,
  staleRoutes: 1,
  freshRoutes: 1,
  unknownHealthRoutes: 0,
  onDemandUnknownHealthRoutes: 0,
  staleRecovery: {
    staleRoutes: 1,
    automaticProbeRoutes: 1,
    recoveryEligibleRoutes: 1,
  },
  driftReasons: ["declared candidates (0) differ from runtime-projected candidates (2)"],
};

const inSync: RuntimeRouteDriftReport = {
  status: "in_sync",
  declaredCandidates: 2,
  explicitDeclaredCandidates: 2,
  runtimeProjectedCandidates: 2,
  projectedInventoryBasis: "declared_policy",
  inventoryExpectation: "declared_policy",
  inventoryJustification: "Model routing declares an explicit candidate set in policy configuration.",
  blockedRoutes: 0,
  quarantinedRoutes: 0,
  staleRoutes: 0,
  freshRoutes: 2,
  unknownHealthRoutes: 0,
  onDemandUnknownHealthRoutes: 0,
  staleRecovery: {
    staleRoutes: 0,
    automaticProbeRoutes: 2,
    recoveryEligibleRoutes: 0,
  },
  driftReasons: [],
};

const policy: ModelRoutingPolicy = {
  candidates: [
    { adapterType: "openai", model: "gpt-5.5", enabled: true, status: "healthy", qualityScore: 95, costScore: 20 },
    { adapterType: "anthropic", model: "claude-opus", enabled: false, status: "disabled", qualityScore: 90, costScore: 40 },
  ],
};

describe("benchmark result summary gating", () => {
  it("parses promptfoo-style JSON without live provider credentials", () => {
    const summary = parsePromptfooResultSummary({
      results: [{ success: true }, { success: false }, { status: "passed" }],
    });
    expect(summary).toEqual({
      source: "promptfoo",
      total: 3,
      passed: 2,
      failed: 1,
      passRate: 2 / 3,
    });
  });

  it("flags benchmark recommendations as stale when route provenance has drifted", () => {
    const summary = buildGatedBenchmarkSummary({
      promptfooResult: { stats: { total: 10, successes: 9, failures: 1 } },
      routeDrift: drifted,
      policy,
    });

    expect(summary.warnings.join("\n")).toContain("Runtime routing provenance is stale");
    expect(summary.recommendations[0]).toMatchObject({ status: "stale_warning" });
    expect(summary.recommendations[0].warnings.join("\n")).toContain("declared candidates");
  });

  it("does not let benchmark warnings override an explicit owner-pinned route", () => {
    const explicitRoute = resolveConfiguredModelRoute({
      roleSlug: "executor",
      roleType: null,
      manualAdapterType: "openai",
      manualModel: "gpt-5.5",
      policy,
    });
    const summary = buildGatedBenchmarkSummary({
      promptfooResult: { results: [{ success: true }] },
      routeDrift: drifted,
      policy,
      explicitRoute,
    });

    expect(explicitRoute.source).toBe("manual_role");
    expect(summary.recommendations[0]).toMatchObject({ status: "usable", warnings: [] });
  });

  it("does not let benchmark warnings bypass disabled hive-model settings", () => {
    const summary = buildGatedBenchmarkSummary({
      promptfooResult: { results: [{ success: true }] },
      routeDrift: inSync,
      policy,
    });

    expect(summary.recommendations[1]).toMatchObject({ status: "disabled" });
    expect(summary.recommendations[1].warnings.join("\n")).toContain("disabled in hive model routing settings");
  });
});
