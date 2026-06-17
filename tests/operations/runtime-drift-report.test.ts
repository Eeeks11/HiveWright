import { describe, expect, it, vi } from "vitest";
import {
  buildRuntimeBuildProvenance,
  buildRuntimeDriftOperatorReport,
  buildRuntimeRouteDriftReport,
} from "@/operations/runtime-drift-report";
import type { ModelRoutingView } from "@/model-routing/registry";
import type { DispatcherHeartbeatRecord } from "@/dispatcher/heartbeat";
import type { HiveOperatorVerdict } from "@/operations/operator-verdict";
import type { ContextProvenance } from "@/adapters/types";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";

function heartbeat(state: DispatcherHeartbeatRecord["state"]): DispatcherHeartbeatRecord {
  return {
    state,
    dispatcherId: "default",
    pid: state === "missing" ? null : 123,
    hostId: state === "missing" ? null : "host-a",
    version: "0.1.4",
    buildHash: "build-a",
    lastHeartbeatAt: state === "missing" ? null : "2026-06-03T00:00:00.000Z",
    ageMs: state === "fresh" ? 1_000 : state === "stale" ? 300_000 : null,
  };
}

function routingView(input: {
  declared?: number;
  runtime?: number;
  blocked?: boolean;
  quarantined?: boolean;
  stale?: boolean;
} = {}): ModelRoutingView {
  const declared = input.declared ?? 1;
  const runtime = input.runtime ?? declared;
  const models = Array.from({ length: runtime }, (_, index) => {
    const status: "healthy" | "unhealthy" = input.blocked && index === 0 ? "unhealthy" : "healthy";
    const probeFreshness: "fresh" | "due" = input.stale && index === 0 ? "due" : "fresh";
    return ({
    id: `model-${index}`,
    routeKey: `provider:adapter:model-${index}`,
    provider: "provider",
    adapterType: "adapter",
    model: `model-${index}`,
    credentialId: null,
    credentialName: null,
    credentialFingerprint: null,
    healthFingerprint: "fp",
    capabilities: [],
    fallbackPriority: index,
    hiveModelEnabled: !(input.blocked && index === 0),
    routingEnabled: !(input.blocked && index === 0),
    roleSlugs: [],
    status,
    qualityScore: null,
    costScore: null,
    capabilityScores: [],
    costPerInputToken: null,
    costPerOutputToken: null,
    local: false,
    lastProbedAt: null,
    lastFailedAt: null,
    lastFailureReason: input.quarantined && index === 0 ? JSON.stringify({ failureClass: "quarantined" }) : null,
    failureClass: input.quarantined && index === 0 ? "quarantined" : null,
    failureMessage: null,
    nextProbeAt: null,
    probeFreshness,
    probeMode: "automatic" as const,
    latencyMs: null,
    sampleCostUsd: null,
  });
  });
  return {
    models,
    policy: {
      candidates: models.map((model) => ({
        adapterType: model.adapterType,
        model: model.model,
        enabled: model.hiveModelEnabled && model.routingEnabled,
        status: model.status,
        probeFreshness: model.probeFreshness,
      })),
    },
    basePolicyState: {
      source: declared > 0 ? "hive" : "none",
      rawRow: null,
      policy: declared > 0
        ? { candidates: Array.from({ length: declared }, (_, index) => ({ adapterType: "adapter", model: `declared-${index}` })) }
        : null,
    },
    profiles: {} as ModelRoutingView["profiles"],
  };
}

const verdict: HiveOperatorVerdict = {
  status: "ready",
  canRunNow: true,
  summary: "ready",
  checkedAt: "2026-06-03T00:00:00.000Z",
  blockers: [{ code: "warning", severity: "warning", label: "Review", detail: "A warning" }],
  signals: {
    schedules: { enabled: 1 },
    runnableTasks: 0,
    pendingDecisions: 0,
    modelHealth: { enabled: 1, ready: 1, blocked: 0, stale: 0, unavailable: 0, onDemand: 0 },
    budgetBlocks: 0,
    stuckActiveTasks: 0,
    deliverables: { total: 0, ownerAccessible: 0, lastCompletedAt: null, lastOpenUrl: null },
    lastSuccessfulGoalCompletion: { completedAt: null, evidenceReferencesDeliverable: false },
    recovery: { interruptedActiveRecovered: 0, executionRunsInterruptedRecovered: 0, lastRecoveryAt: null, hasRecoveryEvidence: false },
    executionRuns: { running: 0, recentFailed: 0, latestStatus: null, latestLivenessState: null, latestLivenessReason: null },
    resumeReadiness: {
      status: "ready",
      canResumeSafely: true,
      counts: { enabledSchedules: 1, runnableTasks: 0, pendingDecisions: 0, unresolvableTasks: 0 },
      sessions: { persistentRoutes: 0, fallbackRoutes: 0, routes: [] },
    },
  },
};

describe("runtime drift report builder", () => {
  it("captures repo/build provenance without requiring live git when a SHA is supplied", () => {
    expect(buildRuntimeBuildProvenance({
      repoPath: "/repo",
      bootTime: new Date("2026-06-03T01:02:03.000Z"),
      gitSha: "abc123",
      env: { HIVEWRIGHT_BUILD_HASH: "build-abc" } as unknown as NodeJS.ProcessEnv,
    })).toEqual({
      repoPath: "/repo",
      gitSha: "abc123",
      buildHash: "build-abc",
      bootTime: "2026-06-03T01:02:03.000Z",
    });
  });

  it.each(["fresh", "stale", "missing"] as const)("surfaces %s dispatcher heartbeat state", async (state) => {
    const report = await buildRuntimeDriftOperatorReport({
      sql: vi.fn() as never,
      hiveId: HIVE_ID,
      now: new Date("2026-06-03T00:01:00.000Z"),
      repoPath: "/repo",
      gitSha: "sha",
      loadHeartbeat: async () => heartbeat(state),
      loadRoutingView: async () => routingView(),
      loadOperatorVerdict: async () => verdict,
      loadSupervisorSummary: async () => null,
    });

    expect(report.dispatcherHeartbeat.state).toBe(state);
    expect(report.routeDrift.status).toBe(state === "fresh" ? "in_sync" : state === "missing" ? "runtime_unavailable" : "drift");
  });

  it.each([
    ["unavailable", null],
    ["none", { status: "none", entries: [], disclaimer: "none" }],
    ["available", { status: "available", entries: [{ sourceClass: "task", reference: "tasks:t1", sourceId: "t1", sourceTaskId: null, category: null }], disclaimer: "available" }],
  ] as Array<[ContextProvenance["status"], ContextProvenance | null]>)("surfaces %s task-context provenance", async (expectedStatus, provenance) => {
    const report = await buildRuntimeDriftOperatorReport({
      sql: vi.fn() as never,
      hiveId: HIVE_ID,
      taskId: provenance ? "task-1" : null,
      repoPath: "/repo",
      gitSha: "sha",
      loadHeartbeat: async () => heartbeat("fresh"),
      loadRoutingView: async () => routingView(),
      loadOperatorVerdict: async () => verdict,
      loadSupervisorSummary: async () => null,
      loadProvenance: async () => provenance ?? { status: "unavailable", entries: [], disclaimer: "unavailable" },
    });
    expect(report.provenance.status).toBe(expectedStatus);
  });

  it.each([null, { id: "report-1", ranAt: new Date("2026-06-03T00:00:00.000Z"), findings: 2, actionsEmitted: 1, actionsApplied: 1 }])(
    "surfaces supervisor report summary when present: %s",
    async (summary) => {
      const report = await buildRuntimeDriftOperatorReport({
        sql: vi.fn() as never,
        hiveId: HIVE_ID,
        repoPath: "/repo",
        gitSha: "sha",
        loadHeartbeat: async () => heartbeat("fresh"),
        loadRoutingView: async () => routingView(),
        loadOperatorVerdict: async () => verdict,
        loadSupervisorSummary: async () => summary,
      });
      expect(report.supervisorReport).toEqual(summary);
    },
  );

  it("surfaces operator verdict blockers", async () => {
    const report = await buildRuntimeDriftOperatorReport({
      sql: vi.fn() as never,
      hiveId: HIVE_ID,
      repoPath: "/repo",
      gitSha: "sha",
      loadHeartbeat: async () => heartbeat("fresh"),
      loadRoutingView: async () => routingView(),
      loadOperatorVerdict: async () => ({ ...verdict, status: "blocked", canRunNow: false }),
      loadSupervisorSummary: async () => null,
    });
    expect(report.operatorVerdict.status).toBe("blocked");
    expect(report.operatorVerdict.blockers[0].code).toBe("warning");
  });

  it("reports declared/runtime route drift and blocked/quarantined/stale route counts", () => {
    const drift = buildRuntimeRouteDriftReport(routingView({ declared: 1, runtime: 2, blocked: true, quarantined: true, stale: true }), heartbeat("fresh"));
    expect(drift).toMatchObject({
      status: "drift",
      declaredCandidates: 1,
      runtimeProjectedCandidates: 2,
      projectedInventoryBasis: "declared_policy",
      blockedRoutes: 1,
      quarantinedRoutes: 1,
      staleRoutes: 1,
      freshRoutes: 1,
      staleRecovery: {
        staleRoutes: 1,
        automaticProbeRoutes: 2,
        recoveryEligibleRoutes: 0,
      },
    });
    expect(drift.driftReasons.join("\n")).toContain("declared candidates");
  });

  it("narrows projected inventory to usable routes when no declared candidates exist", () => {
    const drift = buildRuntimeRouteDriftReport(routingView({ declared: 0, runtime: 85, blocked: true, stale: true }), heartbeat("fresh"));

    expect(drift).toMatchObject({
      status: "drift",
      declaredCandidates: 0,
      runtimeProjectedCandidates: 84,
      projectedInventoryBasis: "usable_runtime_routes",
      blockedRoutes: 1,
      staleRoutes: 1,
      staleRecovery: {
        staleRoutes: 1,
        automaticProbeRoutes: 85,
        recoveryEligibleRoutes: 0,
      },
    });
    expect(drift.driftReasons.join("\n")).toContain("narrowed to usable runtime routes");
  });
});
