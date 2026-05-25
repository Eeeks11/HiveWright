import { beforeEach, describe, expect, it } from "vitest";
import { archiveStaleInternalDecisions } from "@/decisions/cleanup";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const NOW = new Date("2026-05-21T00:00:00Z");

describe("archiveStaleInternalDecisions", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("archives stale internal decisions, keeps old owner approvals pending, and writes an audit event", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('decision-cleanup-hive', 'Decision Cleanup Hive', 'digital')
      RETURNING id
    `;
    const [systemHive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type, is_system_fixture)
      VALUES ('decision-cleanup-system-hive', 'Decision Cleanup System Hive', 'digital', true)
      RETURNING id
    `;
    const [ownerDecision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, priority, status, kind, created_at)
      VALUES (
        ${hive.id},
        'Approve launch budget',
        'Owner approval is required before spending more than the approved budget.',
        'Approve the budget increase.',
        'low',
        'pending',
        'decision',
        ${new Date("2026-04-01T00:00:00Z")}
      )
      RETURNING id
    `;
    const [aiPeerDecision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, options, priority, status, kind, created_at)
      VALUES (
        ${hive.id},
        'AI peer quality review: route handler',
        'AI peer review only.',
        ${sql.json({ kind: "task_quality_feedback", lane: "ai_peer" })},
        'low',
        'pending',
        'task_quality_feedback',
        ${new Date("2026-04-01T00:00:00Z")}
      )
      RETURNING id
    `;
    const [systemDecision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, priority, status, kind, created_at)
      VALUES (
        ${systemHive.id},
        'System fixture diagnostic',
        'Fixture hive internal prompt.',
        'low',
        'ea_review',
        'decision',
        ${new Date("2026-04-01T00:00:00Z")}
      )
      RETURNING id
    `;
    const [recentInternal] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, options, priority, status, kind, created_at)
      VALUES (
        ${hive.id},
        'AI peer quality review: recent task',
        'AI peer review only.',
        ${sql.json({ kind: "task_quality_feedback", lane: "ai_peer" })},
        'low',
        'pending',
        'task_quality_feedback',
        ${new Date("2026-05-20T00:00:00Z")}
      )
      RETURNING id
    `;
    const [urgentInternal] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, priority, status, kind, created_at)
      VALUES (
        ${hive.id},
        'Urgent watchdog failure',
        'Watchdog failed and needs explicit operator review.',
        'urgent',
        'pending',
        'system_error',
        ${new Date("2026-04-01T00:00:00Z")}
      )
      RETURNING id
    `;

    const result = await archiveStaleInternalDecisions(sql, {
      now: NOW,
      olderThanDays: 14,
    });

    expect(result.archivedDecisionIds).toEqual(expect.arrayContaining([
      aiPeerDecision.id,
      systemDecision.id,
    ]));
    expect(result.archivedDecisionIds).not.toContain(ownerDecision.id);
    expect(result.archivedDecisionIds).not.toContain(recentInternal.id);
    expect(result.archivedDecisionIds).not.toContain(urgentInternal.id);

    const rows = await sql<{ id: string; status: string; resolved_by: string | null }[]>`
      SELECT id, status, resolved_by
      FROM decisions
      WHERE id IN (${ownerDecision.id}, ${aiPeerDecision.id}, ${systemDecision.id}, ${recentInternal.id}, ${urgentInternal.id})
      ORDER BY id
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(ownerDecision.id)).toMatchObject({ status: "pending", resolved_by: null });
    expect(byId.get(recentInternal.id)).toMatchObject({ status: "pending", resolved_by: null });
    expect(byId.get(urgentInternal.id)).toMatchObject({ status: "pending", resolved_by: null });
    expect(byId.get(aiPeerDecision.id)).toMatchObject({ status: "archived", resolved_by: "decision-cleanup" });
    expect(byId.get(systemDecision.id)).toMatchObject({ status: "archived", resolved_by: "decision-cleanup" });

    const auditRows = await sql<{ event_type: string; target_type: string; metadata: Record<string, unknown> }[]>`
      SELECT event_type, target_type, metadata
      FROM agent_audit_events
      WHERE target_type = 'decision_cleanup'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe("decision.archived");
    expect(auditRows[0].metadata.archivedDecisionIds).toEqual(expect.arrayContaining([
      aiPeerDecision.id,
      systemDecision.id,
    ]));
  });
});
