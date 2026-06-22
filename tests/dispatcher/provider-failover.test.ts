import { describe, expect, it } from "vitest";
import { decideProviderFailoverRoute } from "@/dispatcher/provider-failover";
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

describe("provider failover drill routing", () => {
  it("keeps a healthy Claude primary on its configured adapter and model", () => {
    const decision = decideProviderFailoverRoute({
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.4",
      primaryHealth: healthDecision({
        healthy: true,
        reason: "model_health_and_provisioner_healthy",
      }),
      fallbackHealth: null,
    });

    expect(decision).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      canRun: true,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_adapter_healthy",
    });
    expect(decision.diagnostic).toContain("Final route selection: claude-code/anthropic/claude-sonnet-4-6 (primary; reason=primary_adapter_healthy).");
  });

  it("routes a Claude outage to a fallback that recovers from stale health on refresh", () => {
    const decision = decideProviderFailoverRoute({
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.4",
      primaryHealth: healthDecision({
        healthy: false,
        reason: "provisioner_unhealthy",
        detail: "Claude provisioner offline",
      }),
      fallbackHealth: healthDecision({
        healthy: true,
        reason: "model_health_and_provisioner_healthy",
        refresh: {
          attempted: true,
          initialReason: "health_probe_stale",
          outcome: "recovered",
          finalReason: "fresh_healthy_probe",
          result: {
            candidates: 1,
            considered: 1,
            probed: 1,
            healthy: 1,
            unhealthy: 0,
            skippedFresh: 0,
            skippedDisabled: 0,
            skippedCredentialErrors: 0,
            errors: 0,
          },
        },
      }),
    });

    expect(decision).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.4",
      canRun: true,
      usedFallback: true,
      clearFallbackModel: true,
      reason: "primary_unhealthy_fallback_healthy",
    });
    expect(decision.diagnostic).toContain("Fallback route codex/openai-codex/gpt-5.4: routable");
    expect(decision.diagnostic).toContain("refresh=recovered");
    expect(decision.diagnostic).toContain("from=health_probe_stale");
  });

  it("routes an unhealthy local Ollama primary to its declared fallback after a stale reprobe remains unhealthy", () => {
    const decision = decideProviderFailoverRoute({
      roleSlug: "dev-agent",
      primaryAdapterType: "ollama",
      primaryModel: "ollama/qwen3.6:35b",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.5",
      primaryHealth: healthDecision({
        healthy: false,
        reason: "health_probe_unhealthy",
        refresh: {
          attempted: true,
          initialReason: "health_probe_stale",
          outcome: "still_unhealthy",
          finalReason: "health_probe_unhealthy",
        },
      }),
      fallbackHealth: healthDecision({
        healthy: true,
        reason: "model_health_and_provisioner_healthy",
      }),
    });

    expect(decision).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      canRun: true,
      usedFallback: true,
      clearFallbackModel: true,
      reason: "primary_unhealthy_fallback_healthy",
    });
    expect(decision.diagnostic).toContain("Primary route ollama/ollama/qwen3.6:35b: unroutable");
    expect(decision.diagnostic).toContain("refresh=still_unhealthy");
    expect(decision.diagnostic).toContain("Fallback route codex/openai-codex/gpt-5.5: routable");
  });

  it("parks instead of spawning when both primary and fallback are unhealthy", () => {
    const decision = decideProviderFailoverRoute({
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: "codex",
      fallbackModel: "openai-codex/gpt-5.4",
      primaryHealth: healthDecision({
        healthy: false,
        reason: "health_probe_stale",
        refresh: {
          attempted: true,
          initialReason: "health_probe_stale",
          outcome: "still_unhealthy",
          finalReason: "health_probe_unhealthy",
        },
      }),
      fallbackHealth: healthDecision({
        healthy: false,
        reason: "health_probe_unhealthy",
        detail: "provider quota exhausted",
      }),
    });

    expect(decision).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      canRun: false,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_and_fallback_unhealthy",
    });
  });

  it("runs a healthy primary even when a role has no declared fallback path", () => {
    const decision = decideProviderFailoverRoute({
      roleSlug: "dev-agent",
      primaryAdapterType: "claude-code",
      primaryModel: "anthropic/claude-sonnet-4-6",
      fallbackAdapterType: null,
      fallbackModel: null,
      primaryHealth: healthDecision({
        healthy: true,
        reason: "model_health_and_provisioner_healthy",
      }),
      fallbackHealth: null,
    });

    expect(decision).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      canRun: true,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_adapter_healthy",
    });
    expect(decision.diagnostic).toContain("Fallback route declaration: missing.");
    expect(decision.diagnostic).toContain("Affected role: dev-agent");
  });

  it("parks an unhealthy local Ollama primary with role and route-family diagnostics when no fallback path is declared", () => {
    const decision = decideProviderFailoverRoute({
      roleSlug: "local-worker",
      primaryAdapterType: "ollama",
      primaryModel: "ollama/qwen3.6:35b",
      fallbackAdapterType: null,
      fallbackModel: null,
      primaryHealth: healthDecision({
        healthy: false,
        reason: "health_probe_unhealthy",
      }),
      fallbackHealth: null,
    });

    expect(decision).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3.6:35b",
      canRun: false,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "no_declared_fallback_route",
    });
    expect(decision.diagnostic).toContain("Fallback route declaration: missing.");
    expect(decision.diagnostic).toContain("Affected role: local-worker");
    expect(decision.diagnostic).toContain("route family: local/ollama");
  });

  it("does not classify cloud-hosted qwen or gemma models as local Ollama routes", () => {
    const decision = decideProviderFailoverRoute({
      roleSlug: "cloud-worker",
      primaryAdapterType: "openrouter",
      primaryModel: "google/gemma-4-26b-a4b:free",
      fallbackAdapterType: null,
      fallbackModel: null,
      primaryHealth: healthDecision({
        healthy: false,
        reason: "health_probe_unhealthy",
      }),
      fallbackHealth: null,
    });

    expect(decision.reason).toBe("no_declared_fallback_route");
    expect(decision.diagnostic).toContain("route family: openrouter");
    expect(decision.diagnostic).not.toContain("route family: local/ollama");
  });
});
