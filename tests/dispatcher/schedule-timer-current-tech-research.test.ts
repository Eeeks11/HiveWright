import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const runCurrentTechResearchDailyMock = vi.fn();

vi.mock("@/current-tech-research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/current-tech-research")>()),
  runCurrentTechResearchDaily: runCurrentTechResearchDailyMock,
}));

let hiveId: string;
let scheduleId: string;

beforeEach(async () => {
  await truncateAll(sql);
  runCurrentTechResearchDailyMock.mockReset();
  runCurrentTechResearchDailyMock.mockResolvedValue({
    goalId: "goal-1",
    cycleDate: "2026-04-28",
    goalCreated: false,
    planUpdated: false,
    kickoffCreated: true,
    duplicate: false,
  });

  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('current-tech-sched-test', 'Current Tech Schedule Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  const [schedule] = await sql<Array<{ id: string }>>`
    INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
    VALUES (
      ${hiveId}::uuid,
      '30 8 * * *',
      ${sql.json({
        kind: "current-tech-research-daily",
        assignedTo: "goal-supervisor",
        title: "Current tech research daily cycle",
        brief: "(populated at run time)",
      })},
      true,
      NOW() - interval '1 minute',
      'test'
    )
    RETURNING id
  `;
  scheduleId = schedule.id;
});

describe("checkAndFireSchedules - current-tech-research-daily", () => {
  it("routes the due schedule into the runtime and advances the schedule without enqueueing a placeholder task", async () => {
    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    expect(runCurrentTechResearchDailyMock).toHaveBeenCalledTimes(1);
    expect(runCurrentTechResearchDailyMock).toHaveBeenCalledWith(sql, {
      hiveId,
      trigger: {
        kind: "schedule",
        scheduleId,
      },
    });

    const tasks = await sql`
      SELECT id FROM tasks WHERE hive_id = ${hiveId} AND title = 'Current tech research daily cycle'
    `;
    expect(tasks).toHaveLength(0);

    const [after] = await sql<Array<{ last_run_at: Date; next_run_at: Date }>>`
      SELECT last_run_at, next_run_at FROM schedules WHERE id = ${scheduleId}
    `;
    expect(after.last_run_at).not.toBeNull();
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });
});
