import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHiveResumeReadiness: vi.fn(),
}));

vi.mock("@/hives/resume-readiness", () => ({
  getHiveResumeReadiness: mocks.getHiveResumeReadiness,
}));

import { getHiveOperatorVerdict } from "@/operations/operator-verdict";

const HIVE_ID = "b6b815ba-5109-4066-8a33-cc5560d3a0e1";

function createSql(row: Record<string, unknown>) {
  return vi.fn(() => Promise.resolve([row]));
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    status: "running",
    canResumeSafely: false,
    counts: {
      enabledSchedules: 1,
      runnableTasks: 2,
      pendingDecisions: 0,
      unresolvableTasks: 0,
    },
    models: {
      enabled: 1,
      ready: 1,
      blocked: 0,
      stale: 0,
      unavailable: 0,
      onDemand: 0,
      blockedRoutes: [],
    },
    sessions: {
      persistentRoutes: 1,
      fallbackRoutes: 0,
      routes: [],
    },
    blockers: [],
    checkedAt: "2026-05-17T19:00:00.000Z",
    ...overrides,
  };
}

describe("getHiveOperatorVerdict", () => {
  it("returns a runnable verdict with business operation signals", async () => {
    mocks.getHiveResumeReadiness.mockResolvedValue(readiness());
    const sql = createSql({
      budget_blocks: 0,
      stuck_active_tasks: 0,
      deliverables_total: 1,
      owner_accessible_deliverables: 1,
      last_deliverable_completed_at: new Date("2026-05-17T18:00:00Z"),
      last_open_url: "/api/work-products/wp-1/open",
      last_goal_completed_at: new Date("2026-05-17T18:05:00Z"),
      last_completion_evidence_references_deliverable: true,
      interrupted_active_recovered: 1,
      execution_runs_running: 1,
      execution_runs_interrupted_recovered: 1,
      execution_runs_recent_failed: 0,
      latest_execution_run_status: "running",
      latest_execution_run_liveness_state: "live",
      latest_execution_run_liveness_reason: "last stdout output",
      last_recovery_at: new Date("2026-05-17T17:00:00Z"),
    });

    const verdict = await getHiveOperatorVerdict(sql as never, {
      hiveId: HIVE_ID,
      now: new Date("2026-05-17T19:00:00Z"),
      checkModelHealth: vi.fn(),
    });

    expect(verdict.status).toBe("running");
    expect(verdict.canRunNow).toBe(true);
    expect(verdict.signals.runnableTasks).toBe(2);
    expect(verdict.signals.modelHealth.ready).toBe(1);
    expect(verdict.signals.deliverables.ownerAccessible).toBe(1);
    expect(verdict.signals.lastSuccessfulGoalCompletion.evidenceReferencesDeliverable).toBe(true);
    expect(verdict.signals.recovery.hasRecoveryEvidence).toBe(true);
    expect(verdict.signals.recovery.executionRunsInterruptedRecovered).toBe(1);
    expect(verdict.signals.executionRuns.running).toBe(1);
    expect(verdict.signals.executionRuns.latestLivenessState).toBe("live");
    expect(verdict.blockers).toEqual([]);
  });

  it("fails closed when budget/model/stuck-task signals are blocking", async () => {
    mocks.getHiveResumeReadiness.mockResolvedValue(readiness({
      status: "blocked",
      models: {
        enabled: 1,
        ready: 0,
        blocked: 1,
        stale: 1,
        unavailable: 0,
        onDemand: 0,
        blockedRoutes: [],
      },
      blockers: [{
        code: "model_health_blocked",
        label: "No runnable model routes",
        count: 1,
        detail: "Probe first.",
      }],
    }));
    const sql = createSql({
      budget_blocks: 1,
      stuck_active_tasks: 2,
      deliverables_total: 1,
      owner_accessible_deliverables: 0,
      last_deliverable_completed_at: null,
      last_open_url: "/private/path/not-leaked",
      last_goal_completed_at: null,
      last_completion_evidence_references_deliverable: false,
      interrupted_active_recovered: 0,
      execution_runs_running: 0,
      execution_runs_interrupted_recovered: 0,
      execution_runs_recent_failed: 1,
      latest_execution_run_status: "failed",
      latest_execution_run_liveness_state: "terminal",
      latest_execution_run_liveness_reason: "adapter_reported_failure",
      last_recovery_at: null,
    });

    const verdict = await getHiveOperatorVerdict(sql as never, { hiveId: HIVE_ID });

    expect(verdict.status).toBe("blocked");
    expect(verdict.canRunNow).toBe(false);
    expect(verdict.blockers.map((b) => b.code)).toEqual(expect.arrayContaining([
      "resume_model_health_blocked",
      "budget_blocked",
      "stuck_active_tasks",
      "no_ready_model_route",
      "deliverables_not_owner_accessible",
      "recent_execution_run_failures",
    ]));
    expect(verdict.summary).toMatch(/cannot run safely/i);
    expect(verdict.signals.deliverables.lastOpenUrl).toBeNull();
  });

  it("counts file-backed final artifacts as owner-openable deliverables", async () => {
    mocks.getHiveResumeReadiness.mockResolvedValue(readiness());
    const sql = createSql({
      budget_blocks: 0,
      stuck_active_tasks: 0,
      deliverables_total: 1,
      owner_accessible_deliverables: 1,
      last_deliverable_completed_at: new Date("2026-05-17T18:00:00Z"),
      last_open_url: `/deliverables/55f4bfcb-b4a7-444f-934b-3cb712046b63/open`,
      last_goal_completed_at: new Date("2026-05-17T18:05:00Z"),
      last_completion_evidence_references_deliverable: true,
      interrupted_active_recovered: 0,
      execution_runs_running: 0,
      execution_runs_interrupted_recovered: 0,
      execution_runs_recent_failed: 0,
      latest_execution_run_status: "succeeded",
      latest_execution_run_liveness_state: "terminal",
      latest_execution_run_liveness_reason: "adapter_succeeded",
      last_recovery_at: null,
    });

    const verdict = await getHiveOperatorVerdict(sql as never, { hiveId: HIVE_ID });

    const queryText = String((sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(queryText).toContain("'/deliverables/' || wp.id::text || '/open'");
    expect(queryText).toContain("wp.file_path IS NOT NULL");
    expect(verdict.signals.deliverables.ownerAccessible).toBe(1);
    expect(verdict.signals.deliverables.lastOpenUrl).toBe("/deliverables/55f4bfcb-b4a7-444f-934b-3cb712046b63/open");
    expect(verdict.blockers.find((b) => b.code === "deliverables_not_owner_accessible")).toBeUndefined();
  });

});
