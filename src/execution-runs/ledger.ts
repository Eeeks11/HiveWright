import { hostname } from "node:os";
import type { Sql } from "postgres";
import type { UsageDetails } from "@/usage/billable-usage";

type ExecutionRunUsageDetails = UsageDetails | Record<string, unknown>;

export type ExecutionRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "blocked";
export type ExecutionRunEventType = "started" | "output" | "status" | "diagnostic" | "finished" | "blocked" | "interrupted" | "recovered" | "error";
export type ExecutionRunLivenessState = "pending" | "live" | "quiet" | "terminal" | "interrupted" | "recovered";

const EXCERPT_BYTE_LIMIT = 16_384;
const ERROR_BYTE_LIMIT = 8_192;

export interface ExecutionRunRecord {
  id: string;
  hiveId: string;
  taskId: string | null;
  goalId: string | null;
  status: ExecutionRunStatus;
  livenessState: ExecutionRunLivenessState;
}

interface ExecutionRunRow {
  id: string;
  hive_id: string;
  task_id: string | null;
  goal_id: string | null;
  status: string;
  liveness_state: string;
  dispatcher_pid?: number | null;
}

export interface StartExecutionRunInput {
  hiveId: string;
  taskId?: string | null;
  goalId?: string | null;
  adapterType: string;
  model?: string | null;
  sessionId?: string | null;
  dispatcherPid?: number | null;
  processGroupId?: number | null;
  hostId?: string | null;
  retryOfRunId?: string | null;
  continuationAttempt?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AppendExecutionRunEventInput {
  runId: string;
  hiveId: string;
  taskId?: string | null;
  eventType: ExecutionRunEventType;
  message?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface RecordExecutionRunOutputInput {
  runId: string;
  hiveId: string;
  taskId?: string | null;
  type: "stdout" | "stderr" | "status" | "diagnostic" | "done";
  text: string;
  payload?: Record<string, unknown> | null;
}

export interface FinishExecutionRunInput {
  runId: string;
  hiveId: string;
  status: Exclude<ExecutionRunStatus, "pending" | "running">;
  finalizationResult?: string | null;
  errorMessage?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  sessionId?: string | null;
  model?: string | null;
  freshInputTokens?: number | null;
  cachedInputTokens?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  estimatedBillableCostCents?: number | null;
  usageDetails?: ExecutionRunUsageDetails | null;
  logRef?: string | null;
  logHash?: string | null;
  logBytes?: number | null;
}

export interface ExecutionRunSignalSummary {
  running: number;
  interruptedRecovered: number;
  recentFailed: number;
  latestStatus: ExecutionRunStatus | null;
  latestLivenessState: ExecutionRunLivenessState | null;
  latestLivenessReason: string | null;
  lastRecoveryAt: Date | null;
}

export async function startExecutionRun(sql: Sql, input: StartExecutionRunInput): Promise<ExecutionRunRecord> {
  const [row] = await sql<ExecutionRunRow[]>`
    INSERT INTO execution_runs (
      hive_id,
      task_id,
      goal_id,
      adapter_type,
      model,
      session_id,
      dispatcher_pid,
      process_group_id,
      host_id,
      status,
      liveness_state,
      retry_of_run_id,
      continuation_attempt,
      metadata
    )
    VALUES (
      ${input.hiveId},
      ${input.taskId ?? null},
      ${input.goalId ?? null},
      ${input.adapterType},
      ${input.model ?? null},
      ${input.sessionId ?? null},
      ${input.dispatcherPid ?? process.pid},
      ${input.processGroupId ?? null},
      ${input.hostId ?? hostname()},
      'running',
      'live',
      ${input.retryOfRunId ?? null},
      ${input.continuationAttempt ?? 0},
      ${input.metadata ? sql.json(input.metadata as never) : null}
    )
    RETURNING id, hive_id, task_id, goal_id, status, liveness_state
  `;

  if (!row) throw new Error("Failed to create execution run ledger row");

  await appendExecutionRunEvent(sql, {
    runId: row.id,
    hiveId: row.hive_id,
    taskId: row.task_id,
    eventType: "started",
    message: `Execution run started via ${input.adapterType}`,
    payload: {
      adapterType: input.adapterType,
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      dispatcherPid: input.dispatcherPid ?? process.pid,
      hostId: input.hostId ?? hostname(),
      continuationAttempt: input.continuationAttempt ?? 0,
    },
  });

  return normalizeExecutionRun(row);
}

export async function appendExecutionRunEvent(sql: Sql, input: AppendExecutionRunEventInput): Promise<void> {
  await sql`
    INSERT INTO execution_run_events (run_id, hive_id, task_id, event_type, message, payload)
    SELECT id, hive_id, task_id, ${input.eventType}, ${input.message ?? null}, ${input.payload ? sql.json(input.payload as never) : null}
    FROM execution_runs
    WHERE id = ${input.runId}
      AND hive_id = ${input.hiveId}
  `;
  await sql`
    UPDATE execution_runs
    SET last_event_at = NOW(), updated_at = NOW()
    WHERE id = ${input.runId}
      AND hive_id = ${input.hiveId}
  `;
}

export async function recordExecutionRunOutput(sql: Sql, input: RecordExecutionRunOutputInput): Promise<void> {
  const byteLength = Buffer.byteLength(input.text, "utf8");
  const stdoutAppend = input.type === "stdout" ? input.text : "";
  const stderrAppend = input.type === "stderr" ? input.text : "";
  await sql`
    UPDATE execution_runs
    SET stdout_excerpt = CASE
          WHEN ${stdoutAppend} = '' THEN stdout_excerpt
          ELSE right(COALESCE(stdout_excerpt, '') || ${stdoutAppend}, ${EXCERPT_BYTE_LIMIT})
        END,
        stderr_excerpt = CASE
          WHEN ${stderrAppend} = '' THEN stderr_excerpt
          ELSE right(COALESCE(stderr_excerpt, '') || ${stderrAppend}, ${EXCERPT_BYTE_LIMIT})
        END,
        output_bytes = output_bytes + ${byteLength},
        last_output_at = CASE WHEN ${byteLength} > 0 THEN NOW() ELSE last_output_at END,
        last_event_at = NOW(),
        liveness_state = CASE WHEN status = 'running' THEN 'live' ELSE liveness_state END,
        liveness_reason = CASE WHEN status = 'running' THEN ${`last ${input.type} output`} ELSE liveness_reason END,
        updated_at = NOW()
    WHERE id = ${input.runId}
      AND hive_id = ${input.hiveId}
  `;
  await appendExecutionRunEvent(sql, {
    runId: input.runId,
    hiveId: input.hiveId,
    taskId: input.taskId,
    eventType: input.type === "diagnostic" ? "diagnostic" : input.type === "status" ? "status" : "output",
    message: boundedText(input.text, ERROR_BYTE_LIMIT),
    payload: { type: input.type, bytes: byteLength, ...(input.payload ?? {}) },
  });
}

export async function finishExecutionRun(sql: Sql, input: FinishExecutionRunInput): Promise<void> {
  const rows = await sql<ExecutionRunRow[]>`
    UPDATE execution_runs
    SET status = ${input.status},
        liveness_state = CASE
          WHEN ${input.status} = 'interrupted' THEN 'interrupted'
          ELSE 'terminal'
        END,
        liveness_reason = ${input.finalizationResult ?? input.errorMessage ?? input.status},
        finished_at = COALESCE(finished_at, NOW()),
        last_event_at = NOW(),
        exit_code = ${input.exitCode ?? null},
        signal = ${input.signal ?? null},
        session_id = COALESCE(${input.sessionId ?? null}, session_id),
        model = COALESCE(${input.model ?? null}, model),
        fresh_input_tokens = ${input.freshInputTokens ?? null},
        cached_input_tokens = ${input.cachedInputTokens ?? null},
        tokens_input = ${input.tokensInput ?? null},
        tokens_output = ${input.tokensOutput ?? null},
        estimated_billable_cost_cents = ${input.estimatedBillableCostCents ?? null},
        usage_details = ${input.usageDetails ? sql.json(input.usageDetails as never) : null},
        log_ref = ${input.logRef ?? null},
        log_hash = ${input.logHash ?? null},
        log_bytes = ${input.logBytes ?? null},
        finalization_result = ${input.finalizationResult ?? null},
        error_message = ${input.errorMessage ? boundedText(input.errorMessage, ERROR_BYTE_LIMIT) : null},
        updated_at = NOW()
    WHERE id = ${input.runId}
      AND hive_id = ${input.hiveId}
      AND status IN ('pending', 'running')
    RETURNING id, hive_id, task_id, goal_id, status, liveness_state
  `;

  for (const row of rows) {
    await appendExecutionRunEvent(sql, {
      runId: row.id,
      hiveId: row.hive_id,
      taskId: row.task_id,
      eventType: "finished",
      message: input.finalizationResult ?? input.status,
      payload: { status: input.status },
    });
  }
}


export async function markExecutionRunBlocked(sql: Sql, input: { runId: string; hiveId: string; reason: string }): Promise<void> {
  await finishExecutionRun(sql, {
    runId: input.runId,
    hiveId: input.hiveId,
    status: "blocked",
    finalizationResult: "runtime_blocked",
    errorMessage: input.reason,
  });
}

export async function markInterruptedRunningExecutionRuns(
  sql: Sql,
  input: {
    dispatcherPid?: number | null;
    hostId?: string | null;
    reason?: string | null;
    pidAlive?: (pid: number) => boolean;
  } = {},
): Promise<ExecutionRunRecord[]> {
  const reason = input.reason ?? "Interrupted by dispatcher lifecycle recovery";
  const candidates = await sql<ExecutionRunRow[]>`
    SELECT id, hive_id, task_id, goal_id, status, liveness_state, dispatcher_pid
    FROM execution_runs
    WHERE status = 'running'
      AND (${input.dispatcherPid ?? null}::integer IS NULL OR dispatcher_pid IS NULL OR dispatcher_pid <> ${input.dispatcherPid ?? null})
      AND (${input.hostId ?? null}::text IS NULL OR host_id = ${input.hostId ?? null})
  `;

  const recovered: ExecutionRunRow[] = [];
  for (const candidate of candidates) {
    if (candidate.dispatcher_pid && (input.pidAlive ?? pidIsAlive)(candidate.dispatcher_pid)) continue;

    const rows = await sql<ExecutionRunRow[]>`
      UPDATE execution_runs
      SET status = 'interrupted',
          liveness_state = 'recovered',
          liveness_reason = ${reason},
          finalization_result = 'startup_recovery_interrupted',
          error_message = ${reason},
          finished_at = COALESCE(finished_at, NOW()),
          last_event_at = NOW(),
          updated_at = NOW()
      WHERE id = ${candidate.id}
        AND status = 'running'
      RETURNING id, hive_id, task_id, goal_id, status, liveness_state, dispatcher_pid
    `;

    for (const row of rows) {
      await appendExecutionRunEvent(sql, {
        runId: row.id,
        hiveId: row.hive_id,
        taskId: row.task_id,
        eventType: "recovered",
        message: reason,
        payload: { previousStatus: "running", recoveredByPid: process.pid, recoveredByHost: hostname() },
      });
      recovered.push(row);
    }
  }

  return recovered.map(normalizeExecutionRun);
}


export async function summarizeExecutionRunSignals(
  sql: Sql,
  input: { hiveId: string; now?: Date; recentWindowHours?: number },
): Promise<ExecutionRunSignalSummary> {
  const now = input.now ?? new Date();
  const recentWindowHours = input.recentWindowHours ?? 24;
  const [row] = await sql<{
    running: number | string;
    interrupted_recovered: number | string;
    recent_failed: number | string;
    latest_status: string | null;
    latest_liveness_state: string | null;
    latest_liveness_reason: string | null;
    last_recovery_at: Date | null;
  }[]>`
    WITH latest AS (
      SELECT status, liveness_state, liveness_reason
      FROM execution_runs
      WHERE hive_id = ${input.hiveId}
      ORDER BY started_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM execution_runs WHERE hive_id = ${input.hiveId} AND status = 'running')::int AS running,
      (SELECT COUNT(*) FROM execution_runs WHERE hive_id = ${input.hiveId} AND status = 'interrupted' AND liveness_state = 'recovered')::int AS interrupted_recovered,
      (SELECT COUNT(*) FROM execution_runs WHERE hive_id = ${input.hiveId} AND status = 'failed' AND finished_at >= ${now} - (${recentWindowHours}::text || ' hours')::interval)::int AS recent_failed,
      (SELECT status FROM latest) AS latest_status,
      (SELECT liveness_state FROM latest) AS latest_liveness_state,
      (SELECT liveness_reason FROM latest) AS latest_liveness_reason,
      (SELECT MAX(updated_at) FROM execution_runs WHERE hive_id = ${input.hiveId} AND status = 'interrupted' AND liveness_state = 'recovered') AS last_recovery_at
  `;

  return {
    running: Number(row?.running ?? 0),
    interruptedRecovered: Number(row?.interrupted_recovered ?? 0),
    recentFailed: Number(row?.recent_failed ?? 0),
    latestStatus: normalizeStatus(row?.latest_status),
    latestLivenessState: normalizeLivenessState(row?.latest_liveness_state),
    latestLivenessReason: row?.latest_liveness_reason ?? null,
    lastRecoveryAt: row?.last_recovery_at ?? null,
  };
}

function normalizeExecutionRun(row: ExecutionRunRow): ExecutionRunRecord {
  return {
    id: row.id,
    hiveId: row.hive_id,
    taskId: row.task_id,
    goalId: row.goal_id,
    status: normalizeStatus(row.status) ?? "running",
    livenessState: normalizeLivenessState(row.liveness_state) ?? "live",
  };
}

function normalizeStatus(status: string | null | undefined): ExecutionRunStatus | null {
  if (
    status === "pending" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "blocked"
  ) {
    return status;
  }
  return null;
}

function normalizeLivenessState(state: string | null | undefined): ExecutionRunLivenessState | null {
  if (state === "pending" || state === "live" || state === "quiet" || state === "terminal" || state === "interrupted" || state === "recovered") {
    return state;
  }
  return null;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function boundedText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
}
