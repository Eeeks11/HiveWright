import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../tests/_lib/test-db";
import { DEFAULT_SCHEDULE_REGISTRY, seedDefaultSchedules } from "@/hives/seed-schedules";

const HIVE = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type, description)
    VALUES (${HIVE}, 'seed-biz', 'Seed Co', 'digital', 'A test hive for schedule seeding')
  `;
});

describe("seedDefaultSchedules", () => {
  it("seeds only the supervisor heartbeat for business hives", async () => {
    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: "A test hive",
      kind: "business",
    });

    expect(res).toEqual({ created: 1, skipped: 0 });

    const rows = await sql<{ origin_type: string; origin_key: string | null; cron_expression: string; enabled: boolean; task_template: { kind?: string; title?: string; brief?: string } }[]>`
      SELECT origin_type, origin_key, cron_expression, enabled, task_template
      FROM schedules
      WHERE hive_id = ${HIVE}::uuid
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin_type: "system_default",
      origin_key: "hive-supervisor-heartbeat",
      cron_expression: "*/15 * * * *",
      enabled: true,
    });
    expect(rows[0].task_template).toMatchObject({
      kind: "hive-supervisor-heartbeat",
      assignedTo: "hive-supervisor",
      title: "Hive supervisor heartbeat",
      brief: "(populated at run time)",
    });
  });

  it("seeds only the supervisor heartbeat regardless of hive kind", async () => {
    for (const kind of ["business", "personal_project", "personal_assistant", "research", "creative"] as const) {
      const slug = `seed-kind-${kind}`;
      await truncateAll(sql);
      await sql`
        INSERT INTO hives (id, slug, name, type, description)
        VALUES (${HIVE}, ${slug}, 'Seed Co', 'digital', null)
      `;

      const res = await seedDefaultSchedules(sql, {
        id: HIVE,
        name: "Seed Co",
        description: null,
        kind,
      });
      expect(res).toEqual({ created: 1, skipped: 0 });

      const rows = await sql<{ origin_key: string | null }[]>`
        SELECT origin_key FROM schedules WHERE hive_id = ${HIVE}::uuid
      `;
      expect(rows.map((row) => row.origin_key)).toEqual(["hive-supervisor-heartbeat"]);
    }
  });

  it("keeps proactiveEnabled=false from disabling the core heartbeat", async () => {
    const res = await seedDefaultSchedules(
      sql,
      {
        id: HIVE,
        name: "Seed Co",
        description: "A test hive",
      },
      {
        coreEnabled: true,
        proactiveEnabled: false,
      },
    );

    expect(res).toEqual({ created: 1, skipped: 0 });

    const rows = await sql<{ enabled: boolean; origin_key: string }[]>`
      SELECT enabled, origin_key FROM schedules
      WHERE hive_id = ${HIVE}::uuid
    `;
    expect(rows).toEqual([{ enabled: true, origin_key: "hive-supervisor-heartbeat" }]);
  });

  it("creates isolated system default instances for each hive without copying custom schedules", async () => {
    const secondHive = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await sql`
      INSERT INTO hives (id, slug, name, type, description)
      VALUES (${secondHive}, 'second-biz', 'Second Co', 'digital', null)
    `;
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        ${HIVE}::uuid,
        '5 5 * * *',
        ${sql.json({ assignedTo: "custom-role", title: "Hive A custom schedule", brief: "Do not copy me" })},
        true,
        'owner'
      )
    `;

    await seedDefaultSchedules(sql, { id: HIVE, name: "Seed Co", description: "A test hive" });
    await seedDefaultSchedules(sql, { id: secondHive, name: "Second Co", description: null });

    const rows = await sql<{ hive_id: string; origin_type: string; origin_key: string | null; task_template: { title?: string } }[]>`
      SELECT hive_id, origin_type, origin_key, task_template FROM schedules
      WHERE hive_id IN (${HIVE}::uuid, ${secondHive}::uuid)
      ORDER BY hive_id, origin_key NULLS LAST
    `;

    expect(rows.filter((row) => row.hive_id === HIVE)).toHaveLength(2);
    expect(rows.filter((row) => row.hive_id === secondHive)).toHaveLength(1);
    expect(rows.filter((row) => row.hive_id === secondHive).some((row) => row.task_template.title === "Hive A custom schedule")).toBe(false);
    expect(rows.filter((row) => row.origin_type === "system_default")).toHaveLength(2);
    expect(rows.filter((row) => row.origin_type === "custom")).toHaveLength(1);
  });

  it("does not overwrite owner-edited default schedule cron or enabled state on rerun", async () => {
    await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });
    await sql`
      UPDATE schedules
      SET cron_expression = '45 6 * * *', enabled = false
      WHERE hive_id = ${HIVE}::uuid
        AND origin_type = 'system_default'
        AND origin_key = 'hive-supervisor-heartbeat'
    `;

    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });

    expect(res).toEqual({ created: 0, skipped: 1 });
    const [row] = await sql<{ cron_expression: string; enabled: boolean }[]>`
      SELECT cron_expression, enabled FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND origin_type = 'system_default'
        AND origin_key = 'hive-supervisor-heartbeat'
    `;
    expect(row).toEqual({ cron_expression: "45 6 * * *", enabled: false });
  });

  it("is idempotent — second run does not create duplicate heartbeat schedules", async () => {
    await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });
    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });
    expect(res).toEqual({ created: 0, skipped: 1 });

    const [{ c: total }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules WHERE hive_id = ${HIVE}::uuid
    `) as unknown as { c: number }[];
    expect(total).toBe(1);

    const [{ c: heartbeats }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'hive-supervisor-heartbeat'
    `) as unknown as { c: number }[];
    expect(heartbeats).toBe(1);
  });

  it("treats legacy stringified heartbeat templates as the existing default", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        ${HIVE}::uuid,
        '*/15 * * * *',
        ${JSON.stringify({
          kind: "hive-supervisor-heartbeat",
          assignedTo: "hive-supervisor",
          title: "Hive supervisor heartbeat",
          brief: "(populated at run time)",
        })},
        false,
        'system:seed-default-schedules'
      )
    `;

    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });

    expect(res).toEqual({ created: 0, skipped: 1 });

    const [{ heartbeats }] = await sql<{ heartbeats: number }[]>`
      WITH normalized AS (
        SELECT CASE
          WHEN jsonb_typeof(task_template) = 'string' THEN (task_template #>> '{}')::jsonb
          ELSE task_template
        END AS template
        FROM schedules
        WHERE hive_id = ${HIVE}::uuid
      )
      SELECT COUNT(*)::int AS heartbeats
      FROM normalized
      WHERE template ->> 'kind' = 'hive-supervisor-heartbeat'
    `;
    expect(heartbeats).toBe(1);
  });

  it("does not include removed proactive/internal schedules in the default registry", () => {
    expect(DEFAULT_SCHEDULE_REGISTRY).toEqual([
      {
        key: "hive-supervisor-heartbeat",
        title: "Hive supervisor heartbeat",
        kind: "hive-supervisor-heartbeat",
        cronExpression: "*/15 * * * *",
        tier: "core",
      },
    ]);
  });
});
