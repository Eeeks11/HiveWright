import { describe, expect, it } from "vitest";
import { checkCloseoutDrift, type CloseoutTaskRow } from "@/closeout/drift-check";
import type { CloseoutCanonicalMarker } from "@/closeout/packet-adapter";

const marker: CloseoutCanonicalMarker = {
  terminal_status: "closed",
  final_disposition_label: "goal_completion_accepted",
  source_finding: {
    kind: "goal_appears_complete",
    key: "goal:g1",
  },
  source_record_ref: {
    table: "goal_completions",
    id: "gc1",
  },
  storage_root_family: "db_goal_completion",
};

const terminalTask: CloseoutTaskRow = {
  id: "task-1",
  status: "completed",
  terminal_disposition: marker,
  completed_at: "2026-06-12T10:00:00.000Z",
  updated_at: "2026-06-12T10:00:00.000Z",
};

describe("closeout drift checker", () => {
  it("reports live decisions newer than a terminal task packet", () => {
    const report = checkCloseoutDrift({
      tasks: [terminalTask],
      decisions: [
        {
          id: "decision-1",
          status: "pending",
          task_id: "task-1",
          updated_at: "2026-06-12T11:00:00.000Z",
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "live_decision_after_terminal_packet",
        severity: "blocked",
        sourceTable: "decisions",
        sourceId: "decision-1",
        relatedIds: ["task-1"],
      }),
    ]);
  });

  it("reports unresolved supervisor findings that post-date terminal tasks", () => {
    const report = checkCloseoutDrift({
      tasks: [terminalTask],
      supervisorReports: [
        {
          id: "report-1",
          task_id: "task-1",
          finding_key: "stalled:task-1",
          status: "open",
          created_at: "2026-06-12T11:30:00.000Z",
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "terminal_task_has_newer_unresolved_supervisor_finding",
        severity: "warning",
        sourceTable: "supervisor_reports",
        sourceId: "report-1",
        relatedIds: ["task-1"],
      }),
    ]);
  });

  it("reports terminal tasks missing canonical closeout markers", () => {
    const report = checkCloseoutDrift({
      tasks: [
        {
          ...terminalTask,
          terminal_disposition: null,
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "packet_missing_canonical_marker",
        severity: "blocked",
        sourceTable: "tasks",
        sourceId: "task-1",
        message: expect.stringContaining("missing_canonical_marker"),
      }),
    ]);
  });

  it("reports final artifacts without owner handoff", () => {
    const report = checkCloseoutDrift({
      workProducts: [
        {
          id: "wp-1",
          task_id: "task-1",
          artifact_kind: "final_artifact",
          created_at: "2026-06-12T12:00:00.000Z",
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "artifact_missing_owner_handoff",
        severity: "blocked",
        sourceTable: "work_products",
        sourceId: "wp-1",
        relatedIds: ["task-1"],
      }),
    ]);
  });

  it("reports goal completions whose final artifact evidence lacks an owner-openable handoff", () => {
    const report = checkCloseoutDrift({
      workProducts: [
        {
          id: "wp-1",
          goal_id: "goal-1",
          artifact_kind: "final_artifact",
          created_at: "2026-06-12T12:00:00.000Z",
        },
      ],
      goalCompletions: [
        {
          id: "gc-1",
          goal_id: "goal-1",
          status: "completed",
          evidence: {
            workProductIds: ["wp-1"],
          },
          created_at: "2026-06-12T12:05:00.000Z",
        },
      ],
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "artifact_missing_owner_handoff",
        severity: "blocked",
        sourceTable: "goal_completions",
        sourceId: "gc-1",
        relatedIds: ["goal-1", "wp-1"],
      }),
    );
  });

  it("reports supervisor action/outcome mismatches", () => {
    const report = checkCloseoutDrift({
      supervisorReports: [
        {
          id: "report-1",
          task_id: "task-1",
          action: "close",
          outcome: "needs_owner",
          created_at: "2026-06-12T12:00:00.000Z",
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "supervisor_action_outcome_mismatch",
        severity: "warning",
        sourceTable: "supervisor_reports",
        sourceId: "report-1",
        relatedIds: ["task-1"],
      }),
    ]);
  });

  it("does not report clean terminal closeout rows", () => {
    const report = checkCloseoutDrift({
      tasks: [terminalTask],
      decisions: [
        {
          id: "decision-1",
          status: "resolved",
          task_id: "task-1",
          updated_at: "2026-06-12T09:00:00.000Z",
        },
      ],
      supervisorReports: [
        {
          id: "report-1",
          task_id: "task-1",
          status: "resolved",
          resolved_at: "2026-06-12T09:30:00.000Z",
          created_at: "2026-06-12T09:00:00.000Z",
        },
      ],
      workProducts: [
        {
          id: "wp-1",
          artifact_kind: "final_artifact",
          owner_handoff_url: "/deliverables/wp-1/open",
          created_at: "2026-06-12T09:00:00.000Z",
        },
      ],
      goalCompletions: [
        {
          id: "gc-1",
          goal_id: "goal-1",
          status: "completed",
          evidence: {
            workProductIds: ["wp-1"],
            primaryOpenUrl: "/deliverables/wp-1/open",
          },
          created_at: "2026-06-12T09:00:00.000Z",
        },
      ],
    });

    expect(report.counts.findings).toBe(0);
    expect(report.findings).toEqual([]);
  });
});
