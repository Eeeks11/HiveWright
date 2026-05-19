import type {
  GuardrailAggregateDecision,
  GuardrailAuditEvent,
  GuardrailDecision,
  GuardrailEffect,
  GuardrailProvider,
  GuardrailReason,
  GuardrailRequest,
} from "./types";

const EFFECT_RANK: Record<GuardrailEffect, number> = {
  allow: 0,
  warn: 1,
  approval_required: 2,
  block: 3,
};

function normalizeProviderDecision(provider: string, decision: GuardrailDecision): GuardrailReason {
  return {
    provider,
    effect: decision.effect,
    message: decision.reason,
    metadata: decision.metadata,
  };
}

function exceptionDecision(provider: GuardrailProvider, error: unknown): GuardrailReason {
  const message = error instanceof Error ? error.message : String(error);
  const critical = provider.critical !== false;
  return {
    provider: provider.name,
    effect: critical ? "block" : "warn",
    message: critical
      ? `critical guardrail provider ${provider.name} failed closed: ${message}`
      : `non-critical guardrail provider ${provider.name} failed open with warning: ${message}`,
  };
}

function aggregateReasons(reasons: GuardrailReason[]): GuardrailAggregateDecision {
  const effect = reasons.reduce<GuardrailEffect>((current, reason) => (
    EFFECT_RANK[reason.effect] > EFFECT_RANK[current] ? reason.effect : current
  ), "allow");

  return {
    effect,
    reasons,
    providerDecisions: reasons.map((reason) => ({
      provider: reason.provider,
      effect: reason.effect,
      reason: reason.message,
      metadata: reason.metadata,
    })),
  };
}

function auditEvent(request: GuardrailRequest, decision: GuardrailAggregateDecision): GuardrailAuditEvent {
  return {
    request: {
      hiveId: request.hiveId,
      actorRoleSlug: request.actorRoleSlug,
      connectorSlug: request.connectorSlug,
      operation: request.operation,
      effectType: request.effectType,
      riskTier: request.riskTier,
      defaultDecision: request.defaultDecision,
      metadata: request.metadata,
      argsPresent: request.args !== undefined,
      actionPolicyCount: request.actionPolicies?.length,
      connectorKnown: Boolean(request.connectorDefinition),
    },
    decision,
    at: new Date(),
  };
}

export async function evaluateGuardrails(
  request: GuardrailRequest,
  providers: GuardrailProvider[],
): Promise<GuardrailAggregateDecision> {
  const reasons: GuardrailReason[] = [];

  for (const provider of providers) {
    try {
      const decision = await provider.evaluate(request);
      reasons.push(normalizeProviderDecision(provider.name, decision));
    } catch (error) {
      reasons.push(exceptionDecision(provider, error));
    }
  }

  const aggregate = aggregateReasons(reasons);
  await request.audit?.recordGuardrailDecision?.(auditEvent(request, aggregate));
  return aggregate;
}

export function strongestGuardrailEffect(effects: GuardrailEffect[]): GuardrailEffect {
  return effects.reduce<GuardrailEffect>((current, effect) => (
    EFFECT_RANK[effect] > EFFECT_RANK[current] ? effect : current
  ), "allow");
}
