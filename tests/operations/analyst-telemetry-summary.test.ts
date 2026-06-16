import { describe, expect, it, vi } from "vitest";
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
      blockedRoutes: 2,
      unhealthyRoutes: 1,
      unknownHealthRoutes: 1,
      quarantinedRoutes: 1,
      staleRoutes: 1,
      localRoutes: 1,
      providerCounts: { openai: 1, local: 1, anthropic: 1 },
      adapterCounts: { codex: 1, ollama: 1, claude: 1 },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret-model-name");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("raw-secret-row");
    expect(serialized).not.toContain("stack trace");
  });

  it("combines runtime drift and model routing counts for one hive", async () => {
    const sql = vi.fn();
    const summary = await buildAnalystTelemetrySummary({
      sql: sql as never,
      hiveId: HIVE_ID,
      now: new Date("2026-06-03T00:01:00.000Z"),
      loadHeartbeat: async () => heartbeat("stale"),
      loadRoutingView: async (_sql, hiveId) => {
        expect(hiveId).toBe(HIVE_ID);
        return routingView();
      },
    });

    expect(summary).toMatchObject({
      checkedAt: "2026-06-03T00:01:00.000Z",
      hiveId: HIVE_ID,
      runtimeDrift: {
        dispatcherHeartbeat: {
          state: "stale",
          ageMs: 300_000,
          lastHeartbeatAt: "2026-06-03T00:00:00.000Z",
        },
        routeDrift: {
          status: "drift",
          declaredCandidates: 1,
          runtimeProjectedCandidates: 3,
          blockedRoutes: 2,
          quarantinedRoutes: 1,
          staleRoutes: 1,
        },
      },
      modelRouting: {
        totalRoutes: 3,
        routableRoutes: 1,
        blockedRoutes: 2,
      },
    });
    expect(summary.notices.join("\n")).toContain("Runtime drift status is drift");
  });
});
