import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();

vi.mock("@/adapters/codex", () => ({
  CodexAdapter: class {
    execute = executeMock;
  },
}));

import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let scheduleId: string;

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await truncateAll(sql);
  executeMock.mockReset();

  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('release-scan-sched-regression', 'Release Scan Schedule Regression', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  const [schedule] = await sql<Array<{ id: string }>>`
    INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
    VALUES (
      ${hiveId}::uuid,
      '0 8 * * 1',
      ${sql.json({
        kind: "llm-release-scan",
        assignedTo: "initiative-engine",
        title: "Weekly LLM release scan",
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

describe("checkAndFireSchedules - llm-release-scan regression", () => {
  it("does not create duplicate concurrent runs when a second sweep overlaps the same manual trigger", async () => {
    const researchStarted = createDeferred<void>();
    const releaseResearch = createDeferred<void>();

    executeMock.mockImplementationOnce(async () => {
      researchStarted.resolve();
      await releaseResearch.promise;
      return {
        success: true,
        output: JSON.stringify({
          sources: [
            {
              provider: "openai",
              url: "https://platform.openai.com/docs/models",
              ok: true,
              text: "Official WebSearch evidence: no newer model IDs were published on this source.",
              error: null,
            },
          ],
        }),
      };
    });

    const firstSweep = checkAndFireSchedules(sql);
    await researchStarted.promise;

    const [duringRun] = await sql<Array<{ last_run_at: Date | null; next_run_at: Date | null }>>`
      SELECT last_run_at, next_run_at
      FROM schedules
      WHERE id = ${scheduleId}
    `;
    expect(duringRun.last_run_at).not.toBeNull();
    expect(duringRun.next_run_at).not.toBeNull();
    expect(duringRun.next_run_at!.getTime()).toBeGreaterThan(Date.now());

    const secondSweep = await checkAndFireSchedules(sql);
    expect(secondSweep).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);

    releaseResearch.resolve();

    await expect(firstSweep).resolves.toBe(1);

    const runs = await sql<Array<{ id: string; status: string; trigger_ref: string | null }>>`
      SELECT id, status, trigger_ref
      FROM initiative_runs
      WHERE hive_id = ${hiveId}
        AND trigger_type = 'llm-release-scan'
      ORDER BY started_at ASC, id ASC
    `;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "completed",
      trigger_ref: scheduleId,
    });

    const snapshots = await sql<Array<{ schedule_id: string }>>`
      SELECT schedule_id
      FROM schedule_fire_snapshots
      WHERE schedule_id = ${scheduleId}
    `;
    expect(snapshots).toEqual([{ schedule_id: scheduleId }]);
  });
});
