import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  buildModelRoutePoolCapacityDiagnostic,
  checkModelRoutePoolCapacity,
} from "@/diagnostics/checks";

const NOW = new Date("2026-06-17T00:00:00.000Z");

describe("model route-pool capacity diagnostic", () => {
  it("reads model_health by fingerprint and model_id without requiring adapter_type", async () => {
    const fakeSql = ((strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM hive_models")) {
        return Promise.resolve([
          {
            provider: "openai",
            adapter_type: "codex",
            model_id: "gpt-5.5",
            enabled: true,
            credential_fingerprint: "credential-fingerprint",
          },
        ]);
      }
      if (query.includes("FROM model_health")) {
        expect(query).not.toMatch(/\badapter_type\b/);
        return Promise.resolve([
          {
            fingerprint: "credential-fingerprint",
            model_id: "openai-codex/gpt-5.5",
            status: "healthy",
            next_probe_at: new Date("2026-06-17T01:00:00.000Z"),
          },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;

    const diagnostic = await checkModelRoutePoolCapacity(fakeSql, NOW);

    expect(diagnostic).toMatchObject({
      id: "providers.route_pool_capacity",
      severity: "ok",
      summary: "1/1 model route(s) are currently routable; 0 blocked, 0 stale, 0 unknown.",
      details: "fresh=1 disabled=0 unhealthy=0 staleRecoveryEligible=0",
    });
  });

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

  it("does not count on-demand unprobed routes as automatic unknown-health debt", async () => {
    const fakeSql = ((strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM hive_models")) {
        return Promise.resolve([
          {
            provider: "openai",
            adapter_type: "openai-image",
            model_id: "gpt-image-2",
            enabled: true,
            credential_fingerprint: "credential-fingerprint",
            capabilities: ["image"],
          },
        ]);
      }
      if (query.includes("FROM model_health")) return Promise.resolve([]);
      return Promise.resolve([]);
    }) as unknown as Sql;

    const diagnostic = await checkModelRoutePoolCapacity(fakeSql, NOW);

    expect(diagnostic.summary).toBe("0/1 model route(s) are currently routable; 1 blocked, 0 stale, 0 unknown.");
    expect(diagnostic.details).toBe("fresh=1 disabled=0 unhealthy=0 staleRecoveryEligible=0");
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
