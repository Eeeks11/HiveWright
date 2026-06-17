import { describe, expect, it } from "vitest";
import { buildModelRoutePoolCapacityDiagnostic } from "@/diagnostics/checks";

const NOW = new Date("2026-06-17T00:00:00.000Z");

describe("model route-pool capacity diagnostic", () => {
  it("marks severe route drift critical instead of allowing readiness to look normal", () => {
    const diagnostic = buildModelRoutePoolCapacityDiagnostic({
      totalRoutes: 85,
      routableRoutes: 5,
      disabledRoutes: 0,
      unhealthyRoutes: 14,
      unknownHealthRoutes: 43,
      staleRoutes: 23,
      freshRoutes: 62,
      recoveryEligibleStaleRoutes: 19,
    }, NOW);

    expect(diagnostic).toMatchObject({
      id: "providers.route_pool_capacity",
      severity: "critical",
      summary: "5/85 model route(s) are currently routable; 80 blocked, 23 stale, 43 unknown.",
      details: "fresh=62 disabled=0 unhealthy=14 staleRecoveryEligible=19",
    });
    expect(diagnostic.recommendedAction).toContain("route-pool capacity as degraded");
  });

  it("keeps normal capacity ok while still reporting stale-recovery measurement", () => {
    const diagnostic = buildModelRoutePoolCapacityDiagnostic({
      totalRoutes: 12,
      routableRoutes: 10,
      disabledRoutes: 1,
      unhealthyRoutes: 0,
      unknownHealthRoutes: 0,
      staleRoutes: 1,
      freshRoutes: 11,
      recoveryEligibleStaleRoutes: 1,
    }, NOW);

    expect(diagnostic).toMatchObject({
      severity: "ok",
      summary: "10/12 model route(s) are currently routable; 2 blocked, 1 stale, 0 unknown.",
      details: "fresh=11 disabled=1 unhealthy=0 staleRecoveryEligible=1",
    });
  });
});
