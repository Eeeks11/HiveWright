/**
 * End-to-end coverage for the new-hive creation path in POST /api/hives.
 *
 * The product default is intentionally narrow: new hives get only the
 * supervisor heartbeat. Proactive/domain/platform loops can still exist as
 * explicit schedules, but they are not universal defaults.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { POST as createHive } from "@/app/api/hives/route";
import { seedDefaultSchedules } from "@/hives/seed-schedules";

const TEST_PREFIX = "p4-seed-";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("POST /api/hives — default-schedule seeding", () => {
  it("seeds exactly one supervisor heartbeat schedule for a newly created hive", async () => {
    const slug = TEST_PREFIX + "new-hive";
    const req = new Request("http://localhost:3000/api/hives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Seed Co",
        slug,
        type: "digital",
        kind: "business",
        description: "A hive for schedule-seeding coverage",
      }),
    });
    const res = await createHive(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    const hiveId = body.data.id as string;
    expect(hiveId).toBeDefined();

    const rows = await sql<{
      cron_expression: string;
      enabled: boolean;
      task_template: Record<string, unknown>;
      created_by: string | null;
      origin_key: string | null;
    }[]>`
      SELECT cron_expression, enabled, task_template, created_by, origin_key
      FROM schedules WHERE hive_id = ${hiveId}::uuid
    `;
    expect(rows).toHaveLength(1);

    const heartbeat = rows[0];
    expect(heartbeat).toMatchObject({
      cron_expression: "*/15 * * * *",
      enabled: true,
      created_by: "system:seed-default-schedules",
      origin_key: "hive-supervisor-heartbeat",
    });
    expect(heartbeat.task_template).toMatchObject({
      kind: "hive-supervisor-heartbeat",
      assignedTo: "hive-supervisor",
      title: "Hive supervisor heartbeat",
    });
  });

  it("re-running seedDefaultSchedules against an API-created hive does not create duplicates", async () => {
    const slug = TEST_PREFIX + "idempotent-hive";
    const req = new Request("http://localhost:3000/api/hives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Idempotent Co",
        slug,
        type: "digital",
        kind: "business",
        description: null,
      }),
    });
    const res = await createHive(req);
    expect(res.status).toBe(201);
    const hiveId = (await res.json()).data.id as string;

    const second = await seedDefaultSchedules(sql, {
      id: hiveId,
      name: "Idempotent Co",
      description: null,
    });
    expect(second).toEqual({ created: 0, skipped: 1 });

    const [{ total }] = (await sql`
      SELECT COUNT(*)::int AS total FROM schedules
      WHERE hive_id = ${hiveId}::uuid
    `) as unknown as { total: number }[];
    expect(total).toBe(1);

    const [{ hb }] = (await sql`
      SELECT COUNT(*)::int AS hb FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'hive-supervisor-heartbeat'
    `) as unknown as { hb: number }[];
    expect(hb).toBe(1);
  });
});
