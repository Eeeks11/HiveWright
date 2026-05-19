import { evaluateActionPolicy } from "@/actions/policy";
import type { ConnectorDefinition } from "@/connectors/registry";
import type { GuardrailDecision, GuardrailProvider, GuardrailRequest } from "./types";
import { actionPolicyResultToGuardrailDecision } from "./types";

function operationFor(definition: ConnectorDefinition, operationSlug: string) {
  return definition.operations.find((operation) => operation.slug === operationSlug) ?? null;
}

function grantedScopeSet(grantedScopes: GuardrailRequest["grantedScopes"]): Set<string> {
  if (grantedScopes instanceof Set) return grantedScopes;
  return new Set((grantedScopes ?? []).filter((scope): scope is string => typeof scope === "string"));
}

export function createActionPolicyGuardrailProvider(): GuardrailProvider {
  return {
    name: "action_policy",
    critical: true,
    evaluate(request: GuardrailRequest): GuardrailDecision {
      if (!request.connectorSlug || !request.operation || !request.effectType) {
        return {
          effect: "warn",
          reason: "action policy guardrail skipped: connector, operation, or effect type missing",
        };
      }

      return actionPolicyResultToGuardrailDecision(evaluateActionPolicy({
        hiveId: request.hiveId,
        connectorSlug: request.connectorSlug,
        operation: request.operation,
        effectType: request.effectType,
        defaultDecision: request.defaultDecision ?? "require_approval",
        actorRoleSlug: request.actorRoleSlug,
        args: request.args,
        riskTier: request.riskTier,
        policies: request.actionPolicies,
      }));
    },
  };
}

export function createConnectorScopeGuardrailProvider(): GuardrailProvider {
  return {
    name: "connector_scope",
    critical: true,
    evaluate(request: GuardrailRequest): GuardrailDecision {
      if (!request.connectorSlug || !request.operation) {
        return {
          effect: "warn",
          reason: "connector scope guardrail skipped: connector or operation missing",
        };
      }
      const definition = request.connectorDefinition;
      if (!definition || definition.slug !== request.connectorSlug) {
        return {
          effect: "block",
          reason: `connector scope guardrail blocked unknown connector ${request.connectorSlug}`,
        };
      }
      const operation = operationFor(definition, request.operation);
      if (!operation) {
        return {
          effect: "block",
          reason: `connector scope guardrail blocked unknown operation ${definition.slug}.${request.operation}`,
        };
      }

      const requiredScopes = operation.governance.scopes ?? [];
      if (requiredScopes.length === 0) {
        return {
          effect: "allow",
          reason: `connector scope guardrail found no required scopes for ${definition.slug}.${operation.slug}`,
        };
      }

      const granted = grantedScopeSet(request.grantedScopes);
      const missing = requiredScopes.filter((scope) => !granted.has(scope));
      if (missing.length > 0) {
        return {
          effect: "block",
          reason: `connector scope guardrail blocked ${definition.slug}.${operation.slug}; missing scopes: ${missing.join(", ")}`,
          metadata: { missingScopes: missing, requiredScopes },
        };
      }
      return {
        effect: "allow",
        reason: `connector scope guardrail allowed ${definition.slug}.${operation.slug}; required scopes granted`,
        metadata: { requiredScopes },
      };
    },
  };
}

export function builtInGuardrailProviders(): GuardrailProvider[] {
  return [
    createActionPolicyGuardrailProvider(),
    createConnectorScopeGuardrailProvider(),
  ];
}
