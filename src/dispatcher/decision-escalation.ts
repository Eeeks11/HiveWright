import type { Sql } from "postgres";
import { sendNotification, type SendResult } from "../notifications/sender";

type StaleDecisionRow = {
  id: string;
  hive_id: string;
  title: string;
  context: string;
  priority: string;
};

type EscalationAttemptRow = {
  id: string;
};

export type DecisionEscalationSender = typeof sendNotification;

export interface DecisionEscalationResult {
  decisionId: string;
  messageId: string;
  notification: SendResult;
}

function escalationMessageContent(decision: Pick<StaleDecisionRow, "title">): string {
  return `Dispatcher escalation attempted for stale urgent decision: ${decision.title}`;
}

export async function runStaleDecisionEscalations(
  sql: Sql,
  notify: DecisionEscalationSender = sendNotification,
): Promise<DecisionEscalationResult[]> {
  const stale = await sql<StaleDecisionRow[]>`
    SELECT d.id, d.hive_id, d.title, d.context, d.priority
    FROM decisions d
    WHERE d.priority = 'urgent'
      AND d.status = 'pending'
      AND d.created_at < NOW() - INTERVAL '4 hours'
      AND NOT EXISTS (
        SELECT 1 FROM decision_messages dm
        WHERE dm.decision_id = d.id
        AND dm.created_at > NOW() - INTERVAL '4 hours'
      )
  `;

  const escalated: DecisionEscalationResult[] = [];
  for (const decision of stale) {
    const [attempt] = await sql<EscalationAttemptRow[]>`
      INSERT INTO decision_messages (decision_id, sender, content)
      SELECT d.id, 'dispatcher', ${escalationMessageContent(decision)}
      FROM decisions d
      WHERE d.id = ${decision.id}::uuid
        AND d.priority = 'urgent'
        AND d.status = 'pending'
        AND d.created_at < NOW() - INTERVAL '4 hours'
        AND NOT EXISTS (
          SELECT 1 FROM decision_messages dm
          WHERE dm.decision_id = d.id
            AND dm.created_at > NOW() - INTERVAL '4 hours'
        )
      RETURNING id
    `;

    if (!attempt) continue;

    const notification = await notify(sql, {
      hiveId: decision.hive_id,
      title: `ESCALATION: ${decision.title}`,
      message: `This urgent decision has been pending for over 4 hours: ${decision.context}`,
      priority: "urgent",
      source: "dispatcher",
      idempotencyKey: `stale-decision-escalation:${decision.id}`,
    });

    escalated.push({
      decisionId: decision.id,
      messageId: attempt.id,
      notification,
    });
  }

  return escalated;
}
