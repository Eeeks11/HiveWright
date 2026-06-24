import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStaleDecisionEscalations, type DecisionEscalationSender } from "@/dispatcher/decision-escalation";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STALE_DECISION_ID = "00000000-0000-4000-8000-000000000166";
const RECENT_DECISION_ID = "00000000-0000-4000-8000-000000000167";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}::uuid, 'decision-escalation-hive', 'Decision Escalation Hive', 'digital')
  `;
});

describe("runStaleDecisionEscalations", () => {
  it("records a dispatcher decision message before notifying so a failed attempt is not repeated", async () => {
    await insertUrgentDecision(STALE_DECISION_ID, "looping urgent decision");
    await insertDroppedOutboundNotification(STALE_DECISION_ID);

    const notificationPayloads: unknown[] = [];
    const notify = vi.fn(async (_sql: Sql, payload: Parameters<DecisionEscalationSender>[1]) => {
      notificationPayloads.push(payload);
      return { sent: 0, skipped: 0, errors: 1 };
    }) as DecisionEscalationSender & ReturnType<typeof vi.fn>;

    const first = await runStaleDecisionEscalations(sql, notify);
    const second = await runStaleDecisionEscalations(sql, notify);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notificationPayloads[0]).toMatchObject({
      hiveId: HIVE_ID,
      title: "ESCALATION: looping urgent decision",
      priority: "urgent",
      source: "dispatcher",
      idempotencyKey: `stale-decision-escalation:${STALE_DECISION_ID}`,
    });

    const messages = await sql<{ sender: string; content: string }[]>`
      SELECT sender, content
      FROM decision_messages
      WHERE decision_id = ${STALE_DECISION_ID}::uuid
      ORDER BY created_at ASC
    `;
    expect(messages).toEqual([
      {
        sender: "dispatcher",
        content: "Dispatcher escalation attempted for stale urgent decision: looping urgent decision",
      },
    ]);
  });

  it("does not escalate a stale urgent decision that already has a recent message", async () => {
    await insertUrgentDecision(RECENT_DECISION_ID, "recently discussed urgent decision");
    await sql`
      INSERT INTO decision_messages (decision_id, sender, content, created_at)
      VALUES (${RECENT_DECISION_ID}::uuid, 'owner', 'I am looking at this now.', NOW() - INTERVAL '10 minutes')
    `;

    const notify = vi.fn(async () => ({ sent: 1, skipped: 0, errors: 0 })) satisfies DecisionEscalationSender;

    const result = await runStaleDecisionEscalations(sql, notify);

    expect(result).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
});

async function insertUrgentDecision(id: string, title: string) {
  await sql`
    INSERT INTO decisions (id, hive_id, title, context, recommendation, status, priority, created_at)
    VALUES (
      ${id}::uuid,
      ${HIVE_ID}::uuid,
      ${title},
      'The owner has not answered this urgent decision.',
      'Escalate to the owner.',
      'pending',
      'urgent',
      NOW() - INTERVAL '5 hours'
    )
  `;
}

async function insertDroppedOutboundNotification(decisionId: string) {
  await sql`
    INSERT INTO outbound_notifications (
      hive_id, category, source_table, source_id, entity_type, entity_id,
      channel_id, title, reason, status, payload, notified_at
    )
    VALUES (
      ${HIVE_ID}::uuid,
      'owner_decision',
      'decisions',
      ${decisionId}::uuid,
      'decision',
      ${decisionId}::uuid,
      '1487611062928019600',
      'Decision needs you: looping urgent decision',
      'Previous notification attempt dropped.',
      'dropped',
      ${sql.json({ category: "owner_decision" })},
      NOW() - INTERVAL '30 minutes'
    )
    ON CONFLICT (category, source_table, source_id) DO NOTHING
  `;
}
