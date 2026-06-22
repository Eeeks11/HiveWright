import { describe, expect, it } from "vitest";
import { buildRuntimeHealthGateForensics } from "@/dispatcher/route-health-forensics";
import type { DispatcherModelRouteHealthDecision } from "@/dispatcher/adapter-health";

function healthDecision(
  input: Partial<DispatcherModelRouteHealthDecision> & Pick<DispatcherModelRouteHealthDecision, "healthy" | "reason">,
): DispatcherModelRouteHealthDecision {
  return {
    healthy: input.healthy,
    reason: input.reason,
    detail: input.detail,
    modelHealth: input.modelHealth ?? {
      canRun: input.healthy,
      reason: input.healthy ? "fresh_healthy_probe" : "health_probe_unhealthy",
      status: input.healthy ? "healthy" : "unhealthy",
      fingerprint: "credential:fingerprint-safe",
      lastProbedAt: new Date("2026-06-05T01:00:00.000Z"),
      nextProbeAt: new Date("2026-06-05T01:05:00.000Z"),
      failureReason: input.detail ?? null,
    },
    refresh: input.refresh ?? {
      attempted: false,
      initialReason: null,
      outcome: "not_needed",
      finalReason: input.healthy ? "fresh_healthy_probe" : "health_probe_unhealthy",
    },
  };
}

describe("runtime health gate forensics", () => {
  it("captures durable pre-spawn health, session-null semantics, and build provenance", () => {
    const forensics = buildRuntimeHealthGateForensics({
      roleSlug: "dev-agent",
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.4",
      primaryHealth: healthDecision({
        healthy: false,
        reason: "health_probe_stale",
        modelHealth: {
          canRun: false,
          reason: "health_probe_stale",
          status: "healthy",
          fingerprint: "credential:fingerprint-safe",
          lastProbedAt: new Date("2026-06-05T00:00:00.000Z"),
          nextProbeAt: new Date("2026-06-05T00:05:00.000Z"),
          failureReason: "last healthy probe is stale",
        },
        refresh: {
          attempted: true,
          initialReason: "health_probe_stale",
          outcome: "still_unhealthy",
          finalReason: "health_probe_unhealthy",
          detail: "probe remained unhealthy",
          result: {
            candidates: 1,
            considered: 1,
            probed: 1,
            healthy: 0,
            unhealthy: 1,
            skippedFresh: 0,
            skippedDisabled: 0,
            skippedCredentialErrors: 0,
            errors: 0,
          },
        },
      }),
      fallbackHealth: healthDecision({
        healthy: false,
        reason: "provisioner_unhealthy",
        detail: "fallback provisioner offline",
      }),
      route: {
        adapterType: "claude-code",
        model: "anthropic/claude-sonnet-4-6",
        canRun: false,
        usedFallback: false,
        clearFallbackModel: false,
        reason: "primary_and_fallback_unhealthy",
        diagnostic: "Final route selection: claude-code/anthropic/claude-sonnet-4-6 (blocked; reason=primary_and_fallback_unhealthy).",
      },
      env: {
        HIVEWRIGHT_BUILD_HASH: "build-sha-123",
        npm_package_version: "9.8.7",
      } as unknown as NodeJS.ProcessEnv,
      now: new Date("2026-06-05T02:00:00.000Z"),
      repoRoot: "/does/not/matter",
    });

    expect(forensics).toMatchObject({
      routeStage: "runtime_health_gate",
      blockedBeforeSpawn: true,
      sessionSemantics: {
        sessionId: null,
        adapterSessionExpected: false,
        executionCapsuleExpected: false,
        reason: "dispatcher_blocked_before_adapter_session_startup",
      },
      runtimeBlockFingerprint: expect.any(String),
      routeDeclaration: {
        roleSlug: "dev-agent",
        primaryAdapterType: "claude-code",
        primaryModel: "anthropic/claude-sonnet-4-6",
        fallbackAdapterType: "codex",
        fallbackModel: "openai-codex/gpt-5.4",
      },
      routeDecision: {
        canRun: false,
        usedFallback: false,
        reason: "primary_and_fallback_unhealthy",
      },
      runtimeHealthGate: {
        capturedAt: "2026-06-05T02:00:00.000Z",
        primary: {
          healthy: false,
          reason: "health_probe_stale",
          modelHealth: {
            status: "healthy",
            fingerprint: "credential:fingerprint-safe",
            lastProbedAt: "2026-06-05T00:00:00.000Z",
            nextProbeAt: "2026-06-05T00:05:00.000Z",
            failureReason: "last healthy probe is stale",
          },
          refresh: {
            attempted: true,
            outcome: "still_unhealthy",
            finalReason: "health_probe_unhealthy",
            result: { probed: 1, unhealthy: 1 },
          },
        },
        fallback: {
          healthy: false,
          reason: "provisioner_unhealthy",
          detail: "fallback provisioner offline",
        },
      },
      buildProvenance: {
        version: "9.8.7",
        versionSource: "env",
        buildHash: "build-sha-123",
        buildHashSource: "HIVEWRIGHT_BUILD_HASH",
      },
    });
    expect(forensics.runtimeBlockFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
