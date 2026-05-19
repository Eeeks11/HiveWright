import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterRuntimeHooks, ProbeResult, SessionContext } from "@/adapters/types";
import { Dispatcher } from "@/dispatcher";
import { ensureRuntimeGuardDecision } from "@/decisions/runtime-guard";
import { createGoalSupervisorRuntimeReplanTask } from "@/dispatcher/runtime-replan";
import type { AdapterRuntimeEvent } from "@/execution-guards";
import { testSql as sql, truncateAll } from "../_lib/test-db";

function healthyProbe(): Promise<ProbeResult> {
  return Promise.resolve({
    healthy: true,
    status: "healthy",
    reason: {
      code: "healthy",
      message: "Probe succeeded.",
      failureClass: null,
      retryable: false,
    },
    failureClass: null,
    latencyMs: 0,
    costEstimateUsd: 0,
  });
}

vi.mock("@/dispatcher/session-builder", () => ({
  buildSessionContext: vi.fn(async (_sql: unknown, task: { assignedTo: string } & Record<string, unknown>) => ({
    task: task as unknown as SessionContext["task"],
    roleTemplate: { roleMd: null, soulMd: null, toolsMd: null, slug: task.assignedTo, department: null },
    memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "0/200" },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: "/workspace/hivewrightv2",
    model: "openai-codex/gpt-5.5",
    fallbackModel: null,
    primaryAdapterType: "codex",
    fallbackAdapterType: null,
    credentials: {},
  } satisfies SessionContext)),
}));

vi.mock("@/dispatcher/worktree-manager", () => ({
  provisionTaskWorkspace: vi.fn(async () => ({
    status: "skipped",
    reason: "test",
    worktreePath: null,
  })),
  inheritTaskWorkspaceFromParent: vi.fn(async () => {}),
}));

vi.mock("@/dispatcher/pre-flight", () => ({
  runPreFlightChecks: vi.fn(async () => ({ passed: true, failures: [] })),
}));

function createDispatcherWithAdapter(adapter: Adapter) {
  const dispatcher = new Dispatcher();
  const originalSql = (dispatcher as unknown as { sql: { end: () => Promise<void> } }).sql;
  const internal = dispatcher as unknown as {
    sql: typeof sql;
    resolveAdapter: () => Promise<Adapter>;
    isAdapterHealthy: () => Promise<boolean>;
    executeTask: (task: unknown) => Promise<void>;
  };
  internal.sql = sql;
  internal.resolveAdapter = async () => adapter;
  internal.isAdapterHealthy = async () => true;
  return { dispatcher: internal, close: () => originalSql.end() };
}

function repeatedReadEvent(): AdapterRuntimeEvent {
  return {
    type: "tool_call",
    adapter: "codex",
    toolName: "read_file",
    args: { path: "src/app.ts", start_line: 1 },
    callId: null,
    source: "structured_stream",
    timestamp: new Date("2026-05-19T00:00:00.000Z"),
  };
}

async function seedTask(opts: { goal?: boolean; qaRequired?: boolean } = {}) {
  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${opts.goal ? 'guard-goal-hive' : 'guard-direct-hive'}, 'Guard Hive', 'digital')
    RETURNING id
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES
      ('dev-agent', 'Dev Agent', 'executor', 'codex'),
      ('qa', 'QA', 'system', 'claude-code'),
      ('doctor', 'Doctor', 'system', 'claude-code'),
      ('goal-supervisor', 'Goal Supervisor', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  const goal = opts.goal
    ? (await sql`
        INSERT INTO goals (hive_id, title, status)
        VALUES (${hive.id}, 'Guarded goal', 'active')
        RETURNING id
      `)[0]
    : null;
  const [task] = await sql`
    INSERT INTO tasks (
      hive_id, assigned_to, created_by, status, title, brief, goal_id, qa_required
    )
    VALUES (
      ${hive.id}, 'dev-agent', 'owner', 'active', 'Guarded runtime task', 'Brief',
      ${goal?.id ?? null}, ${opts.qaRequired ?? false}
    )
    RETURNING *
  `;
  return {
    id: task.id,
    hiveId: task.hive_id,
    assignedTo: task.assigned_to,
    createdBy: task.created_by,
    status: task.status,
    priority: task.priority,
    title: task.title,
    brief: task.brief,
    parentTaskId: task.parent_task_id,
    goalId: task.goal_id,
    sprintNumber: task.sprint_number,
    qaRequired: task.qa_required,
    acceptanceCriteria: task.acceptance_criteria,
    retryCount: task.retry_count,
    doctorAttempts: task.doctor_attempts,
    failureReason: task.failure_reason,
    adapterOverride: task.adapter_override,
    modelOverride: task.model_override,
    projectId: task.project_id,
  };
}

function interruptingAdapter(): Adapter {
  return {
    supportsPersistence: false,
    probe: healthyProbe,
    translate: () => "",
    execute: async (_ctx, _onChunk, hooks?: AdapterRuntimeHooks) => {
      for (let i = 0; i < 5; i += 1) {
        await hooks?.onRuntimeEvent?.(repeatedReadEvent());
      }
      if (hooks?.shouldInterrupt?.()) {
        return {
          success: false,
          output: "",
          failureKind: "guard_interrupted",
          failureReason: hooks.interruptReason?.() ?? "runtime guard interrupted",
        };
      }
      return { success: true, output: "should not complete" };
    },
  };
}

beforeEach(async () => {
  await truncateAll(sql);
  delete process.env.HIVEWRIGHT_LOOP_GUARD_MODE;
});

describe("dispatcher guard interruption", () => {
  it("marks goal task execution interrupted, writes diagnostics, skips QA/success, and creates one runtime replan task", async () => {
    const { dispatcher, close } = createDispatcherWithAdapter(interruptingAdapter());
    await close();
    const task = await seedTask({ goal: true, qaRequired: true });

    await dispatcher.executeTask(task);
    await createGoalSupervisorRuntimeReplanTask(sql, task.id, "duplicate call should be idempotent");

    const [updated] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("failed");
    expect(updated.failure_reason).toContain("Runtime guard interrupted");

    const [run] = await sql<{ status: string; finalization_result: string | null }[]>`
      SELECT status, finalization_result FROM execution_runs WHERE task_id = ${task.id}
    `;
    expect(run).toMatchObject({ status: "interrupted", finalization_result: "guard_interrupted" });

    const diagnostics = await sql<{ chunk: string }[]>`
      SELECT chunk FROM task_logs WHERE task_id = ${task.id} AND type = 'diagnostic'
    `;
    expect(diagnostics.some((row) => row.chunk.includes("runtime_loop_guard"))).toBe(true);

    const qaChildren = await sql`SELECT id FROM tasks WHERE parent_task_id = ${task.id} AND assigned_to = 'qa'`;
    const doctorChildren = await sql`SELECT id FROM tasks WHERE parent_task_id = ${task.id} AND assigned_to = 'doctor'`;
    const replanChildren = await sql`
      SELECT id, brief FROM tasks
      WHERE parent_task_id = ${task.id}
        AND assigned_to = 'goal-supervisor'
        AND title LIKE '[Replan] Runtime guard interrupted:%'
    `;
    expect(qaChildren).toHaveLength(0);
    expect(doctorChildren).toHaveLength(0);
    expect(replanChildren).toHaveLength(1);
    expect(replanChildren[0].brief).toContain("Runtime Loop Guard");
  });

  it("blocks direct tasks behind one runtime_guard EA decision and creates no doctor task", async () => {
    const { dispatcher, close } = createDispatcherWithAdapter(interruptingAdapter());
    await close();
    const task = await seedTask({ goal: false, qaRequired: false });

    await dispatcher.executeTask(task);
    await ensureRuntimeGuardDecision(sql, task.id, "duplicate decision should be idempotent");

    const [updated] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("blocked");
    expect(updated.failure_reason).toContain("Runtime guard interrupted");

    const decisions = await sql<{ kind: string; status: string; title: string }[]>`
      SELECT kind, status, title FROM decisions WHERE task_id = ${task.id}
    `;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "runtime_guard",
      status: "ea_review",
    });

    const doctorChildren = await sql`SELECT id FROM tasks WHERE parent_task_id = ${task.id} AND assigned_to = 'doctor'`;
    expect(doctorChildren).toHaveLength(0);
  });
});
