import type { DispatcherModelRouteHealthDecision } from "./adapter-health";

export interface ProviderFailoverInput {
  roleSlug?: string | null;
  primaryAdapterType: string;
  primaryModel: string;
  fallbackAdapterType: string | null | undefined;
  fallbackModel: string | null | undefined;
  primaryHealth: DispatcherModelRouteHealthDecision;
  fallbackHealth?: DispatcherModelRouteHealthDecision | null;
}

export interface ProviderFailoverDecision {
  adapterType: string;
  model: string;
  canRun: boolean;
  usedFallback: boolean;
  clearFallbackModel: boolean;
  reason: string;
  diagnostic: string;
}

/**
 * Dispatcher provider failover policy:
 * - healthy primary: run primary adapter/model
 * - unhealthy primary + healthy declared fallback: run fallback adapter/model
 * - unhealthy primary without a healthy declared fallback: park before spawn
 *   so known-bad runtime paths do not burn tokens or create recovery churn.
 */
export function decideProviderFailoverRoute(input: ProviderFailoverInput): ProviderFailoverDecision {
  if (input.primaryHealth.healthy) {
    return {
      adapterType: input.primaryAdapterType,
      model: input.primaryModel,
      canRun: true,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_adapter_healthy",
      diagnostic: buildDiagnostic(input, {
        adapterType: input.primaryAdapterType,
        model: input.primaryModel,
        canRun: true,
        usedFallback: false,
        clearFallbackModel: false,
        reason: "primary_adapter_healthy",
      }),
    };
  }

  const fallbackDeclared = Boolean(input.fallbackAdapterType && input.fallbackModel);

  if (!fallbackDeclared) {
    return {
      adapterType: input.primaryAdapterType,
      model: input.primaryModel,
      canRun: false,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "no_declared_fallback_route",
      diagnostic: buildDiagnostic(input, {
        adapterType: input.primaryAdapterType,
        model: input.primaryModel,
        canRun: false,
        usedFallback: false,
        clearFallbackModel: false,
        reason: "no_declared_fallback_route",
      }),
    };
  }

  if (
    input.fallbackAdapterType &&
    input.fallbackModel &&
    input.fallbackHealth?.healthy === true
  ) {
    return {
      adapterType: input.fallbackAdapterType,
      model: input.fallbackModel,
      canRun: true,
      usedFallback: true,
      clearFallbackModel: true,
      reason: "primary_unhealthy_fallback_healthy",
      diagnostic: buildDiagnostic(input, {
        adapterType: input.fallbackAdapterType,
        model: input.fallbackModel,
        canRun: true,
        usedFallback: true,
        clearFallbackModel: true,
        reason: "primary_unhealthy_fallback_healthy",
      }),
    };
  }

  return {
    adapterType: input.primaryAdapterType,
    model: input.primaryModel,
    canRun: false,
    usedFallback: false,
    clearFallbackModel: false,
    reason: "primary_and_fallback_unhealthy",
    diagnostic: buildDiagnostic(input, {
      adapterType: input.primaryAdapterType,
      model: input.primaryModel,
      canRun: false,
      usedFallback: false,
      clearFallbackModel: false,
      reason: "primary_and_fallback_unhealthy",
    }),
  };
}

function buildDiagnostic(
  input: ProviderFailoverInput,
  decision: Omit<ProviderFailoverDecision, "diagnostic">,
): string {
  const selection = decision.canRun
    ? decision.usedFallback ? "fallback" : "primary"
    : "blocked";
  const lines = [
    `Final route selection: ${decision.adapterType}/${decision.model} (${selection}; reason=${decision.reason}).`,
    describeRoute("Primary", input.primaryAdapterType, input.primaryModel, input.primaryHealth),
  ];

  if (!input.fallbackAdapterType || !input.fallbackModel) {
    lines.push(missingFallbackDiagnostic(input));
    return lines.join(" ");
  }

  if (input.fallbackHealth) {
    lines.push(
      describeRoute("Fallback", input.fallbackAdapterType, input.fallbackModel, input.fallbackHealth),
    );
  } else {
    lines.push(
      `Fallback route ${input.fallbackAdapterType}/${input.fallbackModel}: declared, not preflight-checked because the primary route is runnable.`,
    );
  }

  return lines.join(" ");
}

function missingFallbackDiagnostic(input: ProviderFailoverInput): string {
  const role = input.roleSlug?.trim() || "unknown-role";
  return `Fallback route declaration: missing. Affected role: ${role}; route family: ${routeFamily(input.primaryAdapterType, input.primaryModel)}.`;
}

function routeFamily(adapterType: string, model: string): string {
  const adapter = adapterType.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  if (adapter === "ollama" || normalizedModel.startsWith("ollama/") || normalizedModel.includes("qwen") || normalizedModel.includes("gemma")) {
    return "local/ollama";
  }
  if (adapter === "claude-code") return "cloud/claude-code";
  if (adapter === "codex") return "cloud/codex";
  if (adapter === "gemini") return "cloud/gemini";
  if (adapter === "openai-image") return "cloud/openai-image";
  return adapter || "unknown";
}

function describeRoute(
  label: "Primary" | "Fallback",
  adapterType: string,
  model: string,
  health: DispatcherModelRouteHealthDecision,
): string {
  const parts = [
    `${label} route ${adapterType}/${model}: ${health.healthy ? "routable" : "unroutable"} (${health.reason}${health.detail ? `; ${health.detail}` : ""}).`,
  ];

  if (health.refresh.attempted) {
    const refreshParts = [
      `refresh=${health.refresh.outcome}`,
      `from=${health.refresh.initialReason ?? "unknown"}`,
      `final=${health.refresh.finalReason ?? "unknown"}`,
    ];
    if (health.refresh.result) {
      refreshParts.push(
        `candidates=${health.refresh.result.candidates}`,
        `probed=${health.refresh.result.probed}`,
        `healthy=${health.refresh.result.healthy}`,
        `unhealthy=${health.refresh.result.unhealthy}`,
        `errors=${health.refresh.result.errors}`,
      );
    }
    if (health.refresh.detail) {
      refreshParts.push(health.refresh.detail);
    }
    parts.push(`Refresh outcome: ${refreshParts.join(", ")}.`);
  }

  return parts.join(" ");
}
