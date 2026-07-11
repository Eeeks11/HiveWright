import { describe, expect, it, vi } from "vitest";
import { getHiveWrightHealthSnapshot } from "@/diagnostics/checks";
import {
  buildAnalystModelRoutingSummary,
  buildAnalystTelemetrySummary,
} from "@/operations/analyst-telemetry-summary";
import type { DispatcherHeartbeatRecord } from "@/dispatcher/heartbeat";
import type { ModelRoutingView } from "@/model-routing/registry";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";

function heartbeat(state: DispatcherHeartbeatRecord["state"]): DispatcherHeartbeatRecord {
  return {
    state,
    dispatcherId: "dispatcher-a",
    pid: state === "missing" ? null : 123,
    hostId: state === "missing" ? null : "host-a",
    version: "0.1.4",
    buildHash: "build-a",
    lastHeartbeatAt: state === "missing" ? null : "2026-06-03T00:00:00.000Z",
    ageMs: state === "fresh" ? 1_000 : state === "stale" ? 300_000 : null,
  };
}

function routingView(): ModelRoutingView {
  return {
    models: [
      {
        id: "route-1",
        routeKey: "openai:codex:secret-model-name",
        provider: "OpenAI",
        adapterType: "codex",
        model: "secret-model-name",
        credentialId: "cred-secret-id",
        credentialName: "owner production key",
        credentialFingerprint: "credential-fingerprint-secret",
        healthFingerprint: "health-fingerprint-secret",
        capabilities: ["coding"],
        fallbackPriority: 0,
        hiveModelEnabled: true,
        routingEnabled: true,
        roleSlugs: ["system-health-auditor"],
        status: "healthy",
        qualityScore: 99,
        costScore: 10,
        capabilityScores: [],
        costPerInputToken: "0.01",
        costPerOutputToken: "0.02",
        local: false,
        lastProbedAt: new Date("2026-06-03T00:00:00.000Z"),
        lastFailedAt: null,
        lastFailureReason: null,
        failureClass: null,
        failureMessage: null,
        nextProbeAt: null,
        probeFreshness: "fresh",
        probeMode: "automatic",
        latencyMs: 1200,
        sampleCostUsd: 0.01,
      },
      {
        id: "route-2",
        routeKey: "local:ollama:private-local-model",
        provider: "local",
        adapterType: "ollama",
        model: "private-local-model",
        credentialId: null,
        credentialName: null,
        credentialFingerprint: null,
        healthFingerprint: "local-health-fingerprint",
        capabilities: [],
        fallbackPriority: 1,
        hiveModelEnabled: false,
        routingEnabled: false,
        roleSlugs: [],
        status: "unhealthy",
        qualityScore: null,
        costScore: null,
        capabilityScores: [],
        costPerInputToken: null,
        costPerOutputToken: null,
        local: true,
        lastProbedAt: null,
        lastFailedAt: new Date("2026-06-03T00:00:00.000Z"),
        lastFailureReason: JSON.stringify({ failureClass: "quarantined", message: "secret stack trace" }),
        failureClass: "quarantined",
        failureMessage: "secret stack trace",
        nextProbeAt: new Date("2026-06-03T00:00:00.000Z"),
        probeFreshness: "due",
        probeMode: "on_demand",
        latencyMs: null,
        sampleCostUsd: null,
      },
      {
        id: "route-3",
        routeKey: "anthropic:claude:missing-health-model",
        provider: "anthropic",
        adapterType: "claude",
        model: "missing-health-model",
        credentialId: "cred-secret-id-2",
        credentialName: "owner backup key",
        credentialFingerprint: "credential-fingerprint-secret-2",
        healthFingerprint: "health-fingerprint-secret-2",
        capabilities: ["analysis"],
        fallbackPriority: 2,
        hiveModelEnabled: true,
        routingEnabled: true,
        roleSlugs: [],
        status: "unknown",
        qualityScore: null,
        costScore: null,
        capabilityScores: [],
        costPerInputToken: null,
        costPerOutputToken: null,
        local: false,
        lastProbedAt: null,
        lastFailedAt: null,
        lastFailureReason: null,
        failureClass: null,
        failureMessage: null,
        nextProbeAt: null,
        probeFreshness: "unknown",
        probeMode: "automatic",
        latencyMs: null,
        sampleCostUsd: null,
      },
    ],
    policy: {
      candidates: [
        { adapterType: "codex", model: "secret-model-name", enabled: true, status: "healthy", probeFreshness: "fresh" },
        { adapterType: "ollama", model: "private-local-model", enabled: false, status: "unhealthy", probeFreshness: "due" },
        { adapterType: "claude", model: "missing-health-model", enabled: true, status: "unknown" },
      ],
    },
    basePolicyState: {
      source: "hive",
      rawRow: { id: "row-1", hiveId: HIVE_ID, config: { encrypted: "raw-secret-row" } },
      policy: {
        candidates: [{ adapterType: "codex", model: "secret-model-name" }],
      },
    },
    profiles: {} as ModelRoutingView["profiles"],
  };
}

describe("analyst telemetry summary", () => {
  it("summarizes model routing without exposing raw model, credential, or failure detail", () => {
    const summary = buildAnalystModelRoutingSummary(routingView());

    expect(summary).toMatchObject({
      policySource: "hive",
      totalRoutes: 3,
      routableRoutes: 1,
      disabledRoutes: 1,
      blockedRoutes: 1,
      unhealthyRoutes: 0,
      unknownHealthRoutes: 1,
      quarantinedRoutes: 0,
      staleRoutes: 0,
      freshRoutes: 1,
      localRoutes: 1,
      onDemandUnknownHealthRoutes: 0,
      staleRouteRecovery: {
        staleRoutes: 0,
        automaticProbeRoutes: 2,
        recoveryEligibleRoutes: 0,
        recoveryBlockedRoutes: 0,
      },
      unknownHealthRecovery: {
        unknownHealthRoutes: 1,
        automaticProbeRoutes: 2,
        recoveryEligibleRoutes: 1,
        recoveryBlockedRoutes: 0,
      },
      readinessPolicy: {
        criticalCapacityBasis: "no_routable_or_recoverable_route",
      },
      providerCounts: { openai: 1, local: 1, anthropic: 1 },
      adapterCounts: { codex: 1, ollama: 1, claude: 1 },
      activeRoutePool: {
        routes: 2,
        providerCounts: { openai: 1, anthropic: 1 },
        adapterCounts: { codex: 1, claude: 1 },
      },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret-model-name");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("raw-secret-row");
    expect(serialized).not.toContain("stack trace");
  });

  it("excludes quarantined automatic unknown-health routes from recovery eligibility", () => {
    const view = routingView();
    view.models.push({
      ...view.models[2],
      id: "route-4",
      routeKey: "google:gemini:quarantined-unknown-model",
      provider: "google",
      adapterType: "gemini",
      model: "quarantined-unknown-model",
      status: "unknown",
      failureClass: "quarantined",
      lastFailureReason: JSON.stringify({ failureClass: "quarantined", message: "fixture detail" }),
      failureMessage: "fixture detail",
      probeFreshness: "unknown",
      probeMode: "automatic",
      hiveModelEnabled: true,
      routingEnabled: true,
    });

    const summary = buildAnalystModelRoutingSummary(view);

    expect(summary.unknownHealthRecovery).toMatchObject({
      unknownHealthRoutes: 2,
      automaticProbeRoutes: 3,
      recoveryEligibleRoutes: 1,
      recoveryBlockedRoutes: 1,
    });
    expect(summary.quarantinedRoutes).toBe(0);
  });

  it("separates excluded automatic unknown-health inventory from active recovery backlog", () => {
    const view = routingView();
    view.models = [
      {
        ...view.models[2],
        id: "route-excluded-1",
        routeKey: "openai:codex:excluded-entitlement-model-a",
        provider: "openai",
        adapterType: "codex",
        model: "excluded-entitlement-model-a",
        status: "unknown",
        failureClass: "scope",
        lastFailureReason: JSON.stringify({ failureClass: "scope", message: "fixture detail" }),
        failureMessage: "fixture detail",
        probeFreshness: "unknown",
        probeMode: "automatic",
        hiveModelEnabled: true,
        routingEnabled: true,
      },
      {
        ...view.models[2],
        id: "route-excluded-2",
        routeKey: "openai:codex:excluded-entitlement-model-b",
        provider: "openai",
        adapterType: "codex",
        model: "excluded-entitlement-model-b",
        status: "unknown",
        failureClass: "scope",
        lastFailureReason: JSON.stringify({ failureClass: "scope", message: "fixture detail" }),
        failureMessage: "fixture detail",
        probeFreshness: "unknown",
        probeMode: "automatic",
        hiveModelEnabled: true,
        routingEnabled: true,
      },
      {
        ...view.models[2],
        id: "route-included-unknown",
        routeKey: "anthropic:claude:included-unknown-model",
        provider: "anthropic",
        adapterType: "claude",
        model: "included-unknown-model",
        status: "unknown",
        failureClass: null,
        lastFailureReason: null,
        failureMessage: null,
        probeFreshness: "unknown",
        probeMode: "automatic",
        hiveModelEnabled: true,
        routingEnabled: true,
      },
    ];
    view.policy.candidates = [
      {
        adapterType: "codex",
        model: "excluded-entitlement-model-a",
        enabled: false,
        status: "disabled",
        canonicalRouteSet: {
          source: "configured_route_inventory",
          membership: "excluded",
          routeKey: "openai:codex:excluded-entitlement-model-a",
          reason: "OpenAI Codex health probes report a non-retryable scope/model-entitlement failure, so this route is retained only as excluded inventory rather than an automatic candidate.",
        },
      },
      {
        adapterType: "codex",
        model: "excluded-entitlement-model-b",
        enabled: false,
        status: "disabled",
        canonicalRouteSet: {
          source: "configured_route_inventory",
          membership: "excluded",
          routeKey: "openai:codex:excluded-entitlement-model-b",
          reason: "OpenAI Codex health probes report a non-retryable scope/model-entitlement failure, so this route is retained only as excluded inventory rather than an automatic candidate.",
        },
      },
      {
        adapterType: "claude",
        model: "included-unknown-model",
        enabled: true,
        status: "unknown",
        canonicalRouteSet: {
          source: "configured_route_inventory",
          membership: "included",
          routeKey: "anthropic:claude:included-unknown-model",
          reason: "Route is included in the canonical automatic route pool.",
        },
      },
    ];

    const summary = buildAnalystModelRoutingSummary(view);

    expect(summary.unknownHealthRoutes).toBe(1);
    expect(summary.unknownHealthRecovery).toMatchObject({
      unknownHealthRoutes: 1,
      automaticProbeRoutes: 3,
      recoveryEligibleRoutes: 1,
      recoveryBlockedRoutes: 0,
    });
    expect(summary.activeRoutePool).toMatchObject({
      routes: 1,
      providerCounts: { anthropic: 1 },
      adapterCounts: { claude: 1 },
    });
    expect(summary.excludedRouteInventory).toMatchObject({
      excludedRoutes: 0,
      unknownHealthRoutes: 0,
      automaticProbeRoutes: 0,
      onDemandProbeRoutes: 0,
      reasonCounts: {},
    });
    expect(summary.retainedExcludedRouteInventory).toMatchObject({
      routes: 2,
      unknownHealthRoutes: 2,
      automaticProbeRoutes: 2,
      onDemandProbeRoutes: 0,
      classCounts: {
        codex_scope_or_entitlement_failure: 2,
      },
      classes: [
        expect.objectContaining({
          class: "codex_scope_or_entitlement_failure",
          routes: 2,
          rationale: expect.stringContaining("not intended active capacity"),
          supportPosture: expect.stringContaining("not retry as ordinary live-capacity recovery debt"),
          owningWorkflow: expect.stringContaining("issue #154"),
        }),
      ],
    });
  });

  it("excludes stale excluded automatic routes from recoverable capacity", () => {
    const view = routingView();
    view.models = [
      {
        ...view.models[2],
        id: "route-excluded-due",
        routeKey: "openai:codex:excluded-due-model",
        provider: "openai",
        adapterType: "codex",
        model: "excluded-due-model",
        status: "unknown",
        failureClass: "scope",
        lastFailureReason: JSON.stringify({ failureClass: "scope", message: "fixture detail" }),
        failureMessage: "fixture detail",
        probeFreshness: "due",
        probeMode: "automatic",
        hiveModelEnabled: true,
        routingEnabled: true,
      },
      {
        ...view.models[2],
        id: "route-included-due",
        routeKey: "anthropic:claude:included-due-model",
        provider: "anthropic",
        adapterType: "claude",
        model: "included-due-model",
        status: "unknown",
        failureClass: null,
        lastFailureReason: null,
        failureMessage: null,
        probeFreshness: "due",
        probeMode: "automatic",
        hiveModelEnabled: true,
        routingEnabled: true,
      },
    ];
    view.policy.candidates = [
      {
        adapterType: "codex",
        model: "excluded-due-model",
        enabled: false,
        status: "disabled",
        canonicalRouteSet: {
          source: "configured_route_inventory",
          membership: "excluded",
          routeKey: "openai:codex:excluded-due-model",
          reason: "OpenAI Codex health probes report a non-retryable scope/model-entitlement failure, so this route is retained only as excluded inventory rather than an automatic candidate.",
        },
      },
      {
        adapterType: "claude",
        model: "included-due-model",
        enabled: true,
        status: "unknown",
        canonicalRouteSet: {
          source: "configured_route_inventory",
          membership: "included",
          routeKey: "anthropic:claude:included-due-model",
          reason: "Route is included in the canonical automatic route pool.",
        },
      },
    ];

    const summary = buildAnalystModelRoutingSummary(view);

    expect(summary.staleRouteRecovery).toMatchObject({
      staleRoutes: 1,
      automaticProbeRoutes: 2,
      recoveryEligibleRoutes: 1,
      recoveryBlockedRoutes: 0,
    });
    expect(summary.unknownHealthRecovery).toMatchObject({
      unknownHealthRoutes: 1,
      automaticProbeRoutes: 2,
      recoveryEligibleRoutes: 1,
      recoveryBlockedRoutes: 0,
    });
    expect(summary.activeRoutePool).toMatchObject({
      routes: 1,
      providerCounts: { anthropic: 1 },
      adapterCounts: { claude: 1 },
    });
    expect(summary.excludedRouteInventory).toMatchObject({
      excludedRoutes: 0,
      unknownHealthRoutes: 0,
      automaticProbeRoutes: 0,
      reasonCounts: {},
    });
    expect(summary.retainedExcludedRouteInventory).toMatchObject({
      routes: 1,
      unknownHealthRoutes: 1,
      automaticProbeRoutes: 1,
      classCounts: {
        codex_scope_or_entitlement_failure: 1,
      },
      classes: [
        expect.objectContaining({
          class: "codex_scope_or_entitlement_failure",
          owningWorkflow: expect.stringContaining("issue #154"),
        }),
      ],
    });
  });

  it("scopes stale recovery eligibility to the active route pool", () => {
    const view = routingView();
    view.models = [
      {
        ...view.models[2],
        id: "route-disabled-policy-due",
        routeKey: "openai:codex:disabled-policy-due-model",
        provider: "openai",
        adapterType: "codex",
        model: "disabled-policy-due-model",
        status: "unknown",
        failureClass: null,
        lastFailureReason: null,
        failureMessage: null,
        probeFreshness: "due",
        probeMode: "automatic",
        hiveModelEnabled: true,
        routingEnabled: true,
      },
      {
        ...view.models[2],
        id: "route-missing-policy-due",
        routeKey: "anthropic:claude:missing-policy-due-model",
        provider: "anthropic",
        adapterType: "claude",
        model: "missing-policy-due-model",
        status: "unknown",
        failureClass: null,
        lastFailureReason: null,
        failureMessage: null,
        probeFreshness: "due",
        probeMode: "automatic",
        hiveModelEnabled: true,
        routingEnabled: true,
      },
    ];
    view.policy.candidates = [
      {
        adapterType: "codex",
        model: "disabled-policy-due-model",
        enabled: false,
        status: "disabled",
        canonicalRouteSet: {
          source: "configured_route_inventory",
          membership: "included",
          routeKey: "openai:codex:disabled-policy-due-model",
          reason: "Route is currently disabled by policy.",
        },
      },
    ];

    const summary = buildAnalystModelRoutingSummary(view);

    expect(summary.activeRoutePool).toMatchObject({
      routes: 0,
      providerCounts: {},
      adapterCounts: {},
    });
    expect(summary.staleRoutes).toBe(0);
    expect(summary.staleRouteRecovery).toMatchObject({
      staleRoutes: 0,
      automaticProbeRoutes: 2,
      recoveryEligibleRoutes: 0,
      recoveryBlockedRoutes: 0,
    });
  });

  it("combines runtime drift and model routing counts for one hive", async () => {
    const sql = vi.fn();
    const now = new Date("2026-06-03T00:01:00.000Z");
    const env = { NODE_ENV: "test", HIVEWRIGHT_BUILD_HASH: "live-runtime-build" } as NodeJS.ProcessEnv;
    const health = getHiveWrightHealthSnapshot({ env, now });
    const summary = await buildAnalystTelemetrySummary({
      sql: sql as never,
      hiveId: HIVE_ID,
      now,
      env,
      loadHeartbeat: async () => heartbeat("stale"),
      loadRoutingView: async (_sql, hiveId) => {
        expect(hiveId).toBe(HIVE_ID);
        return routingView();
      },
    });

    expect(health.buildHash).toBe("live-runtime-build");
    expect(summary.improvementScanEvidence.runtimeBuildHash).toBe(health.buildHash);
    expect(summary.improvementScanEvidence.authoritativeProbeSet.every((probe) => probe.buildHash === health.buildHash)).toBe(true);
    expect(summary.improvementScanEvidence.runtimeBuildHash).not.toBe(heartbeat("stale").buildHash);

    expect(summary).toMatchObject({
      checkedAt: "2026-06-03T00:01:00.000Z",
      hiveId: HIVE_ID,
      improvementScanEvidence: {
        purpose: "improvement_scan_publication_gate",
        runtimeBuildHash: "live-runtime-build",
        authoritativeProbeSet: [
          expect.objectContaining({
            endpoint: "/api/analyst-telemetry?hiveId=...",
            checkedAt: "2026-06-03T00:01:00.000Z",
            buildHash: "live-runtime-build",
            authoritativeFor: ["readiness", "model_routing", "runtime_drift"],
          }),
        ],
        promotedFindingRequirements: {
          staleBuildPolicy: "reprobe_endpoint_family_before_publication_or_routing",
          readinessRoutingPrimarySource: "/api/analyst-telemetry?hiveId=...",
        },
      },
      runtimeDrift: {
        dispatcherHeartbeat: {
          state: "stale",
          ageMs: 300_000,
          lastHeartbeatAt: "2026-06-03T00:00:00.000Z",
          version: "0.1.4",
          buildHash: "build-a",
          buildHashScope: "dispatcher_heartbeat",
          buildHashStatus: "differs_from_current_runtime",
          currentRuntimeBuildHash: "live-runtime-build",
          buildHashInterpretation: expect.stringContaining("cached dispatcher heartbeat evidence"),
        },
        routeDrift: {
          status: "drift",
          declaredCandidates: 1,
          runtimeProjectedCandidates: 2,
          projectedInventoryBasis: "declared_policy",
          explicitDeclaredCandidates: 1,
          inventoryExpectation: "declared_policy",
          blockedRoutes: 1,
          quarantinedRoutes: 0,
          staleRoutes: 0,
          staleRecovery: {
            staleRoutes: 0,
            automaticProbeRoutes: 2,
            recoveryEligibleRoutes: 0,
          },
        },
      },
      modelRouting: {
        totalRoutes: 3,
        routableRoutes: 1,
        blockedRoutes: 1,
        unknownHealthRecovery: {
          unknownHealthRoutes: 1,
          automaticProbeRoutes: 2,
          recoveryEligibleRoutes: 1,
          recoveryBlockedRoutes: 0,
        },
        readinessPolicy: {
          criticalCapacityBasis: "no_routable_or_recoverable_route",
        },
      },
    });
    expect(summary.notices.join("\n")).toContain("Runtime drift status is drift");
    expect(summary.notices.join("\n")).toContain("dispatcherHeartbeat.buildHash as cached heartbeat evidence");
  });
});
