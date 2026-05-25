import type { ActionPolicyDecision, ActionPolicyEvaluationResult, EvaluateActionPolicyInput } from "@/actions/policy";
import type { ConnectorDefinition } from "@/connectors/registry";

export type GuardrailEffect = "allow" | "warn" | "approval_required" | "block";

export interface GuardrailReason {
  provider: string;
  effect: GuardrailEffect;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface GuardrailDecision {
  effect: GuardrailEffect;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface GuardrailAggregateDecision {
  effect: GuardrailEffect;
  reasons: GuardrailReason[];
  providerDecisions: Array<{
    provider: string;
    effect: GuardrailEffect;
    reason: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface GuardrailProvider {
  name: string;
  critical?: boolean;
  evaluate(request: GuardrailRequest): Promise<GuardrailDecision> | GuardrailDecision;
}

export interface GuardrailRequest {
  hiveId: string;
  actorRoleSlug?: string | null;
  connectorSlug?: string | null;
  operation?: string | null;
  effectType?: string | null;
  args?: unknown;
  riskTier?: string | null;
  defaultDecision?: ActionPolicyDecision;
  actionPolicies?: EvaluateActionPolicyInput["policies"];
  connectorDefinition?: ConnectorDefinition | null;
  grantedScopes?: string[] | Set<string> | null;
  audit?: GuardrailAuditSink;
  metadata?: Record<string, unknown>;
}

export interface GuardrailAuditSink {
  recordGuardrailDecision?(event: GuardrailAuditEvent): Promise<void> | void;
}

export interface GuardrailAuditEvent {
  request: Omit<GuardrailRequest, "audit" | "args" | "actionPolicies" | "connectorDefinition"> & {
    argsPresent: boolean;
    actionPolicyCount?: number;
    connectorKnown: boolean;
  };
  decision: GuardrailAggregateDecision;
  at: Date;
}

export function mapActionPolicyDecision(decision: ActionPolicyDecision): GuardrailEffect {
  if (decision === "block") return "block";
  if (decision === "require_approval") return "approval_required";
  return "allow";
}

export function actionPolicyResultToGuardrailDecision(result: ActionPolicyEvaluationResult): GuardrailDecision {
  return {
    effect: mapActionPolicyDecision(result.decision),
    reason: result.reason,
    metadata: result.policyId ? { policyId: result.policyId } : undefined,
  };
}
