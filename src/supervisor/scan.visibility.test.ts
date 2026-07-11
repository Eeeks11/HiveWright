import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../tests/_lib/test-db";
import { scanHive } from "./scan";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";

async function seedHive() {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'visibility-hive', 'visibility-hive', 'digital')
  `;
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedHive();
});

describe.sequential("scanHive decision visibility alignment", () => {
  it("counts only owner-visible pending decisions in supervisor metrics", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, route_metadata)
      VALUES (
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01',
        ${HIVE_ID},
        'internal approval chatter',
        'system-only diagnostic decision',
        'pending',
        ${sql.json({ ownerActionRequired: false })}
      )
    `;

    const report = await scanHive(sql, HIVE_ID);

    expect(report.metrics.openDecisions).toBe(0);
    expect(report.operatingContext!.resumeReadiness.counts.pendingDecisions).toBe(0);
  });

  it("does NOT flag owner-hidden internal/system decisions as aging owner decisions", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at, route_metadata)
      VALUES (
        'cccccccc-cccc-cccc-cccc-cccccccccc09',
        ${HIVE_ID},
        'hidden internal approval',
        'system-only route diagnostic',
        'pending',
        'urgent',
        NOW() - interval '5 hours',
        ${sql.json({ ownerActionRequired: false })}
      )
    `;

    const report = await scanHive(sql, HIVE_ID);

    expect(
      report.findings.filter((f) => f.kind === "aging_decision"),
    ).toHaveLength(0);
    expect(report.metrics.openDecisions).toBe(0);
  });
});
