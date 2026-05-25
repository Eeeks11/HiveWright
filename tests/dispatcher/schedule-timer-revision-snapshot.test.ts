import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";

let hiveId: string;
let projectId: string;
let scheduleId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('schedule-snapshot-test', 'Schedule Snapshot Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  const [project] = await sql<Array<{ id: string }>>`
    INSERT INTO projects (hive_id, slug, name)
    VALUES (${hiveId}, 'snapshot-project', 'Snapshot Project')
    RETURNING id
  `;
  projectId = project.id;

  const [schedule] = await sql<Array<{ id: string }>>`
    INSERT INTO schedules (
      hive_id,
      cron_expression,
      task_template,
      enabled,
      next_run_at,
      created_by,
      origin_type,
      origin_key
    )
    VALUES (
      ${hiveId},
      '*/15 * * * *',
      ${sql.json({
        assignedTo: "dev-agent",
        title: "Scheduled generic task",
        brief: "Run the generic task from schedule",
        qaRequired: true,
        priority: 2,
        projectId,
      })},
      true,
      NOW() - interval '1 minute',
      'owner',
      'custom',
      'generic-snapshot'
    )
    RETURNING id
  `;
  scheduleId = schedule.id;
});

describe("checkAndFireSchedules — revision snapshots", () => {
  it("persists a per-fire schedule snapshot and attaches it to generic tasks", async () => {
    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    const [task] = await sql<Array<{
      id: string;
      schedule_revision_snapshot: Record<string, unknown> | null;
    }>>`
      SELECT id, schedule_revision_snapshot
      FROM tasks
      WHERE hive_id = ${hiveId}
        AND title = 'Scheduled generic task'
    `;

    expect(task.schedule_revision_snapshot).toMatchObject({
      schemaVersion: "schedule-revision-snapshot/v1",
      scheduleId,
      hiveId,
      cronExpression: "*/15 * * * *",
      enabled: true,
      origin: {
        type: "custom",
        key: "generic-snapshot",
      },
      createdBy: "owner",
      extension: {
        roleRevision: null,
        skillRevisions: [],
      },
    });
    expect(task.schedule_revision_snapshot?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const fireRows = await sql<Array<{
      schedule_id: string;
      task_id: string | null;
      snapshot_hash: string;
      snapshot: Record<string, unknown>;
    }>>`
      SELECT schedule_id, task_id, snapshot_hash, snapshot
      FROM schedule_fire_snapshots
      WHERE schedule_id = ${scheduleId}
    `;

    expect(fireRows).toHaveLength(1);
    expect(fireRows[0].task_id).toBe(task.id);
    expect(fireRows[0].snapshot_hash).toBe(task.schedule_revision_snapshot?.hash);
    expect(fireRows[0].snapshot).toEqual(task.schedule_revision_snapshot);
  });
});
