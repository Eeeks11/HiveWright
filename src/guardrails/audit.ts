import type { Sql } from "postgres";
import { appendExecutionRunEvent } from "@/execution-runs/ledger";
import type { GuardrailAggregateDecision, GuardrailAuditEvent, GuardrailAuditSink } from "./types";

export function summarizeGuardrailDecision(decision: GuardrailAggregateDecision): string {
  if (decision.reasons.length === 0) return `guardrails resolved ${decision.effect} with no providers`;
  return `guardrails resolved ${decision.effect}: ${decision.reasons.map((reason) => `${reason.provider}=${reason.effect}`).join(", ")}`;
}

export function createExecutionRunGuardrailAuditSink(
  sql: Sql,
  input: { executionRunId?: string | null; hiveId: string; taskId?: string | null },
): GuardrailAuditSink {
  return {
    async recordGuardrailDecision(event: GuardrailAuditEvent): Promise<void> {
      if (!input.executionRunId) return;
      await appendExecutionRunEvent(sql, {
        runId: input.executionRunId,
        hiveId: input.hiveId,
        taskId: input.taskId,
        eventType: event.decision.effect === "block" ? "error" : "diagnostic",
        message: summarizeGuardrailDecision(event.decision),
        payload: {
          guardrails: {
            effect: event.decision.effect,
            reasons: event.decision.providerDecisions,
            request: event.request,
          },
        },
      });
    },
  };
}
