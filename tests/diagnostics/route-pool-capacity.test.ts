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
            last_failure_reason: null,
          },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;

    const diagnostic = await checkModelRoutePoolCapacity(fakeSql, NOW);

    expect(diagnostic).toMatchObject({
      id: "providers.route_pool_capacity",
      label: "Controller-global model route pool capacity",
      severity: "ok",
      summary: "Controller-wide route pool has 1/1 automatic model route(s) currently routable across all hives; 0 blocked, 0 stale, 0 unknown.",
      details: "scope=controller_global hiveScopedReadinessEndpoint=/api/analyst-telemetry?hiveId=... readinessPolicy=critical_only_when_no_routable_or_recoverable_route fresh=1 disabled=0 unhealthy=0 staleRecoveryEligible=0 unknownRecoveryEligible=0 configuredRoutes=1 automaticCandidateRoutes=1 excludedInventoryRoutes=0 intentionallyDisabledRoutes=0",
    });
  });

  it("keeps broad route drift warning-level when some route capacity is still usable", () => {
    const diagnostic = buildModelRoutePoolCapacityDiagnostic({
      totalRoutes: 85,
      routableRoutes: 5,
      disabledRoutes: 0,
      unhealthyRoutes: 14,
      unknownHealthRoutes: 43,
      staleRoutes: 23,
      freshRoutes: 62,
      recoveryEligibleStaleRoutes: 19,
      recoveryEligibleUnknownRoutes: 43,
    }, NOW);

    expect(diagnostic).toMatchObject({
      id: "providers.route_pool_capacity",
      severity: "warning",
      summary: "Controller-wide route pool has 5/85 automatic model route(s) currently routable across all hives; 80 blocked, 23 stale, 43 unknown.",
      details: "scope=controller_global hiveScopedReadinessEndpoint=/api/analyst-telemetry?hiveId=... readinessPolicy=critical_only_when_no_routable_or_recoverable_route fresh=62 disabled=0 unhealthy=14 staleRecoveryEligible=19 unknownRecoveryEligible=43 configuredRoutes=85 automaticCandidateRoutes=85 excludedInventoryRoutes=0 intentionallyDisabledRoutes=0",
    });
    expect(diagnostic.recommendedAction).toContain("stale/unknown recovery eligibility");
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

    expect(diagnostic.summary).toBe("No controller-wide automatic model routes are configured for capacity scoring.");
    expect(diagnostic.details).toBe("scope=controller_global hiveScopedReadinessEndpoint=/api/analyst-telemetry?hiveId=... readinessPolicy=critical_only_when_no_routable_or_recoverable_route fresh=0 disabled=0 unhealthy=0 staleRecoveryEligible=0 unknownRecoveryEligible=0 configuredRoutes=1 automaticCandidateRoutes=0 excludedInventoryRoutes=1 intentionallyDisabledRoutes=0");
  });


  it("quarantines permanent OpenAI Codex entitlement failures from automatic probe debt", async () => {
    const codexRows = Array.from({ length: 43 }, (_, index) => ({
      provider: "openai",
      adapter_type: "codex",
      model_id: `openai-codex/gpt-5.${index + 1}`,
      enabled: true,
      credential_fingerprint: "credential-fingerprint",
      capabilities: ["text", "code"],
    }));
    const fakeSql = ((strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("FROM hive_models")) {
        return Promise.resolve([
          {
            provider: "local",
            adapter_type: "ollama",
            model_id: "qwen3:32b",
            enabled: true,
            credential_fingerprint: "local-fingerprint",
            capabilities: ["text", "code"],
          },
          {
            provider: "local",
            adapter_type: "ollama",
            model_id: "qwen3:14b",
            enabled: true,
            credential_fingerprint: null,
            capabilities: ["text", "code"],
          },
          ...codexRows,
        ]);
      }
      if (query.includes("FROM model_health")) {
        return Promise.resolve([
          {
            fingerprint: "local-fingerprint",
            model_id: "qwen3:32b",
            status: "healthy",
            next_probe_at: new Date("2026-06-17T01:00:00.000Z"),
            last_failure_reason: null,
          },
          ...codexRows.map((row) => ({
            fingerprint: "credential-fingerprint",
            model_id: row.model_id,
            status: "unhealthy",
            next_probe_at: new Date("2026-06-16T01:00:00.000Z"),
            last_failure_reason: '{"failureClass":"scope","message":"model entitlement denied","retryable":false}',
          })),
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;

    const diagnostic = await checkModelRoutePoolCapacity(fakeSql, NOW);

    expect(diagnostic.summary).toBe("Controller-wide route pool has 1/2 automatic model route(s) currently routable across all hives; 1 blocked, 0 stale, 1 unknown.");
    expect(diagnostic.details).toBe("scope=controller_global hiveScopedReadinessEndpoint=/api/analyst-telemetry?hiveId=... readinessPolicy=critical_only_when_no_routable_or_recoverable_route fresh=2 disabled=0 unhealthy=0 staleRecoveryEligible=0 unknownRecoveryEligible=1 configuredRoutes=45 automaticCandidateRoutes=2 excludedInventoryRoutes=43 intentionallyDisabledRoutes=0");
    expect(diagnostic.recommendedAction).toContain("stale/unknown recovery eligibility");
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
      recoveryEligibleUnknownRoutes: 0,
    }, NOW);

    expect(diagnostic).toMatchObject({
      severity: "ok",
      summary: "Controller-wide route pool has 10/12 automatic model route(s) currently routable across all hives; 2 blocked, 1 stale, 0 unknown.",
      details: "scope=controller_global hiveScopedReadinessEndpoint=/api/analyst-telemetry?hiveId=... readinessPolicy=critical_only_when_no_routable_or_recoverable_route fresh=11 disabled=1 unhealthy=0 staleRecoveryEligible=1 unknownRecoveryEligible=0 configuredRoutes=12 automaticCandidateRoutes=12 excludedInventoryRoutes=0 intentionallyDisabledRoutes=1",
    });
  });

  it("keeps route capacity critical when no route can run or recover", () => {
    const diagnostic = buildModelRoutePoolCapacityDiagnostic({
      totalRoutes: 3,
      routableRoutes: 0,
      disabledRoutes: 0,
      unhealthyRoutes: 3,
      unknownHealthRoutes: 0,
      staleRoutes: 0,
      freshRoutes: 3,
      recoveryEligibleStaleRoutes: 0,
      recoveryEligibleUnknownRoutes: 0,
    }, NOW);

    expect(diagnostic.severity).toBe("critical");
    expect(diagnostic.recommendedAction).toContain("restore at least one routable or recoverable route");
  });
});
