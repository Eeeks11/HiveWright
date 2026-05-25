import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll, createFixtureNamespace } from "../_lib/test-db";

async function insertPausedHive(label: string): Promise<string> {
  const ns = createFixtureNamespace(`creation-pause-guards-${label}`);
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES (${ns.slug(label)}, ${`${label} Hive`}, 'digital')
    RETURNING id
  `;

  await sql`
    INSERT INTO hive_runtime_locks (hive_id, creation_paused, reason, paused_by, operating_state)
    VALUES (${hive.id}, true, 'Paused from dashboard', 'owner@example.com', 'paused')
  `;

  return hive.id;
}

describe("creation-pause database guards", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("allows normal goal and task creation while the hive is not paused", async () => {
    const ns = createFixtureNamespace("creation-pause-guards-unpaused");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("unpaused")}, 'Unpaused Hive', 'digital')
      RETURNING id
    `;

    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${hive.id}, 'Normal goal', 'Should not be blocked when the hive is running')
      RETURNING id
    `;

    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${hive.id}, 'dev-agent', 'owner', 'Normal task', 'Should not be blocked when the hive is running')
      RETURNING id
    `;

    expect(goal.id).toMatch(/[0-9a-f-]{36}/);
    expect(task.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("allows creating the resume-approval decision while the hive is paused", async () => {
    const hiveId = await insertPausedHive("resume-approval");

    const [decision] = await sql<{ id: string; status: string; kind: string }[]>`
      INSERT INTO decisions (hive_id, title, context, options, priority, status, kind, route_metadata)
      VALUES (
        ${hiveId},
        'Approve resume from creation pause',
        'Approve the paused-to-running transition for this exact pause state before schedules are re-enabled.',
        ${sql.json([{ key: 'approve', label: 'Approve resume', response: 'approved' }])},
        'urgent',
        'pending',
        'creation_pause_resume_approval',
        ${sql.json({ workflow: 'creation_pause_resume', targetState: 'resume' })}
      )
      RETURNING id, status, kind
    `;

    expect(decision).toMatchObject({
      status: "pending",
      kind: "creation_pause_resume_approval",
    });
  });

  it("still blocks normal pending decisions while the hive is paused", async () => {
    const hiveId = await insertPausedHive("normal-decision");

    await expect(sql`
      INSERT INTO decisions (hive_id, title, context, options, priority, status, kind)
      VALUES (${hiveId}, 'Needs owner input', 'Normal blocked decision', '{}'::jsonb, 'urgent', 'pending', 'decision')
    `).rejects.toThrow(/HIVE_CREATION_PAUSED/);
  });
});
