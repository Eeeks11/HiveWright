import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const runInitiativeEvaluationMock = vi.fn();

vi.mock("@/initiative-engine", () => ({
  runInitiativeEvaluation: runInitiativeEvaluationMock,
}));

import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";

let hiveId: string;
let scheduleId: string;

beforeEach(async () => {
  await truncateAll(sql);
  runInitiativeEvaluationMock.mockReset();
  runInitiativeEvaluationMock.mockResolvedValue({
    runId: "run-1",
    trigger: { kind: "schedule", scheduleId: "sched-1" },
    candidatesEvaluated: 0,
    tasksCreated: 0,
    suppressed: 0,
    noop: 0,
    errored: 0,
    outcomes: [],
  });

  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('initiative-sched-test', 'Initiative Schedule Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  const [schedule] = await sql<Array<{ id: string }>>`
    INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
    VALUES (
      ${hiveId}::uuid,
      '0 * * * *',
      ${sql.json({
        kind: "initiative-evaluation",
        assignedTo: "initiative-engine",
        title: "Initiative evaluation",
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

describe("checkAndFireSchedules — initiative-evaluation", () => {
  it("routes initiative schedules into the runtime and advances the schedule", async () => {
    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    expect(runInitiativeEvaluationMock).toHaveBeenCalledTimes(1);
    expect(runInitiativeEvaluationMock).toHaveBeenCalledWith(sql, {
      hiveId,
      trigger: {
        kind: "schedule",
        scheduleId,
        targetGoalId: null,
      },
    });

    const tasks = await sql`
      SELECT id FROM tasks WHERE hive_id = ${hiveId} AND title = 'Initiative evaluation'
    `;
    expect(tasks).toHaveLength(0);

    const [after] = await sql<Array<{ last_run_at: Date; next_run_at: Date }>>`
      SELECT last_run_at, next_run_at FROM schedules WHERE id = ${scheduleId}
    `;
    expect(after.last_run_at).not.toBeNull();
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("passes through an optional target goal id from the schedule template", async () => {
    const targetGoalId = "14c723f1-e235-467b-9f9f-7f5f0f0d1c9b";
    await sql`
      UPDATE schedules
      SET task_template = jsonb_set(task_template, '{goalId}', to_jsonb(${targetGoalId}::text), true)
      WHERE id = ${scheduleId}
    `;

    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    expect(runInitiativeEvaluationMock).toHaveBeenCalledTimes(1);
    expect(runInitiativeEvaluationMock).toHaveBeenCalledWith(sql, {
      hiveId,
      trigger: {
        kind: "schedule",
        scheduleId,
        targetGoalId,
      },
    });
  });
});
