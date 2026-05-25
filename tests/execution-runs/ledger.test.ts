import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  finishExecutionRun,
  markInterruptedRunningExecutionRuns,
  recordExecutionRunOutput,
  startExecutionRun,
  summarizeExecutionRunSignals,
} from "@/execution-runs/ledger";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("execution run ledger", () => {
  it("records adapter execution attempts with bounded output and final usage", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('execution-run-ledger-hive', 'Execution Run Ledger Hive', 'digital')
      RETURNING id
    `;

    const run = await startExecutionRun(sql, {
      hiveId: hive.id,
      adapterType: "codex",
      model: "gpt-5.5",
      dispatcherPid: 4242,
      metadata: { routeStage: "adapter_execute" },
    });

    await recordExecutionRunOutput(sql, {
      runId: run.id,
      hiveId: hive.id,
      type: "stdout",
      text: "owner-visible progress\n",
    });
    await finishExecutionRun(sql, {
      runId: run.id,
      hiveId: hive.id,
      status: "succeeded",
      finalizationResult: "adapter_succeeded",
      sessionId: "session-1",
      tokensInput: 11,
      tokensOutput: 7,
      estimatedBillableCostCents: 3,
      usageDetails: { inputTokens: 11, outputTokens: 7, estimatedCostCents: 3 },
    });
    await finishExecutionRun(sql, {
      runId: run.id,
      hiveId: hive.id,
      status: "failed",
      finalizationResult: "duplicate_terminal_attempt",
      errorMessage: "should not create a second terminal event",
    });

    const [row] = await sql<{
      status: string;
      liveness_state: string;
      stdout_excerpt: string | null;
      output_bytes: number;
      session_id: string | null;
      tokens_input: number | null;
      estimated_billable_cost_cents: number | null;
    }[]>`
      SELECT status, liveness_state, stdout_excerpt, output_bytes, session_id, tokens_input, estimated_billable_cost_cents
      FROM execution_runs
      WHERE id = ${run.id}
    `;

    expect(row).toMatchObject({
      status: "succeeded",
      liveness_state: "terminal",
      stdout_excerpt: "owner-visible progress\n",
      output_bytes: "owner-visible progress\n".length,
      session_id: "session-1",
      tokens_input: 11,
      estimated_billable_cost_cents: 3,
    });

    const events = await sql<{ event_type: string }[]>`
      SELECT event_type
      FROM execution_run_events
      WHERE run_id = ${run.id}
      ORDER BY created_at, id
    `;
    expect(events.map((event) => event.event_type)).toEqual(["started", "output", "finished"]);
  });

  it("ignores output attempts when the caller supplies a hive id that does not own the run", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('execution-run-owner-hive', 'Execution Run Owner Hive', 'digital')
      RETURNING id
    `;
    const [otherHive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('execution-run-other-hive', 'Execution Run Other Hive', 'digital')
      RETURNING id
    `;
    const run = await startExecutionRun(sql, {
      hiveId: hive.id,
      adapterType: "codex",
      dispatcherPid: 4444,
    });

    await recordExecutionRunOutput(sql, {
      runId: run.id,
      hiveId: otherHive.id,
      type: "stdout",
      text: "cross hive leak attempt\n",
    });

    const [row] = await sql<{ stdout_excerpt: string | null; output_bytes: number }[]>`
      SELECT stdout_excerpt, output_bytes
      FROM execution_runs
      WHERE id = ${run.id}
    `;
    const events = await sql<{ event_type: string; hive_id: string }[]>`
      SELECT event_type, hive_id
      FROM execution_run_events
      WHERE run_id = ${run.id}
      ORDER BY id
    `;

    expect(row).toMatchObject({ stdout_excerpt: null, output_bytes: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "started", hive_id: hive.id });
  });

  it("marks stale running runs recovered during dispatcher lifecycle reconciliation", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('execution-run-recovery-hive', 'Execution Run Recovery Hive', 'digital')
      RETURNING id
    `;

    const stale = await startExecutionRun(sql, {
      hiveId: hive.id,
      adapterType: "claude-code",
      model: "claude-sonnet-4",
      dispatcherPid: 1111,
    });
    const current = await startExecutionRun(sql, {
      hiveId: hive.id,
      adapterType: "codex",
      model: "gpt-5.5",
      dispatcherPid: 2222,
    });
    const liveOtherDispatcher = await startExecutionRun(sql, {
      hiveId: hive.id,
      adapterType: "codex",
      model: "gpt-5.5",
      dispatcherPid: 3333,
    });

    const recovered = await markInterruptedRunningExecutionRuns(sql, {
      dispatcherPid: 2222,
      pidAlive: (pid) => pid === 3333,
      reason: "Interrupted by dispatcher lifecycle recovery: test",
    });

    expect(recovered.map((run) => run.id)).toEqual([stale.id]);

    const signals = await summarizeExecutionRunSignals(sql, { hiveId: hive.id });
    expect(signals.running).toBe(2);
    expect(signals.interruptedRecovered).toBe(1);
    expect(signals.latestStatus).toBe("running");

    const [staleRow] = await sql<{ status: string; liveness_state: string; finalization_result: string | null }[]>`
      SELECT status, liveness_state, finalization_result
      FROM execution_runs
      WHERE id = ${stale.id}
    `;
    const [currentRow] = await sql<{ status: string }[]>`
      SELECT status
      FROM execution_runs
      WHERE id = ${current.id}
    `;
    const [liveOtherDispatcherRow] = await sql<{ status: string }[]>`
      SELECT status
      FROM execution_runs
      WHERE id = ${liveOtherDispatcher.id}
    `;

    expect(staleRow).toMatchObject({
      status: "interrupted",
      liveness_state: "recovered",
      finalization_result: "startup_recovery_interrupted",
    });
    expect(currentRow.status).toBe("running");
    expect(liveOtherDispatcherRow.status).toBe("running");
  });
});
