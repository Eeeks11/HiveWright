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
          agent_task_id: "task-1",
          ran_at: "2026-06-12T11:30:00.000Z",
          actions: {
            actions: [{ kind: "close_task", taskId: "task-1" }],
          },
          action_outcomes: [],
        },
      ],
    });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "terminal_task_has_newer_unresolved_supervisor_finding",
          severity: "warning",
          sourceTable: "supervisor_reports",
          sourceId: "report-1",
          relatedIds: ["task-1"],
        }),
      ]),
    );
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

  it("reports final artifacts without owner-openable routes", () => {
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

  it("accepts current work_products URL/file/content fields as owner-openable routes", () => {
    const report = checkCloseoutDrift({
      workProducts: [
        {
          id: "wp-public",
          artifact_kind: "final_artifact",
          public_url: "https://example.test/final",
          created_at: "2026-06-12T12:00:00.000Z",
        },
        {
          id: "wp-file",
          artifact_kind: "final_artifact",
          file_path: "/home/trent/.hivewright/hives/h1/work-products/final.png",
          created_at: "2026-06-12T12:00:00.000Z",
        },
        {
          id: "wp-content",
          artifact_kind: "final_artifact",
          content: "# Final report\n\nOwner-readable inline content.",
          created_at: "2026-06-12T12:00:00.000Z",
        },
      ],
    });

    expect(report.findings).toEqual([]);
  });

  it("does not accept source_url alone as an owner-openable deliverable route", () => {
    const report = checkCloseoutDrift({
      workProducts: [
        {
          id: "wp-source-only",
          artifact_kind: "final_artifact",
          source_url: "https://example.test/source",
          created_at: "2026-06-12T12:00:00.000Z",
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "artifact_missing_owner_handoff",
        sourceTable: "work_products",
        sourceId: "wp-source-only",
      }),
    ]);
  });

  it("reports goal completions whose final artifact evidence lacks an owner-openable outcome or artifact route", () => {
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

  it("accepts owner_outcomes primary_open_url as the goal completion handoff", () => {
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
          evidence: {
            workProductIds: ["wp-1"],
          },
          created_at: "2026-06-12T12:05:00.000Z",
        },
      ],
      ownerOutcomes: [
        {
          id: "outcome-1",
          goal_id: "goal-1",
          goal_completion_id: "gc-1",
          primary_open_url: "/deliverables/wp-1/open",
          primary_work_product_id: "wp-1",
          created_at: "2026-06-12T12:06:00.000Z",
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "artifact_missing_owner_handoff",
        sourceTable: "work_products",
        sourceId: "wp-1",
      }),
    ]);
  });

  it("reports supervisor action/outcome mismatches", () => {
    const report = checkCloseoutDrift({
      supervisorReports: [
        {
          id: "report-1",
          ran_at: "2026-06-12T12:00:00.000Z",
          actions: {
            actions: [{ kind: "close_task", taskId: "task-1" }],
          },
          action_outcomes: [
            {
              action: { kind: "close_task", taskId: "task-1" },
              status: "error",
            },
          ],
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

  it("does not report clean terminal closeout rows using current schema fields", () => {
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
          agent_task_id: "task-1",
          ran_at: "2026-06-12T09:00:00.000Z",
          actions: {
            actions: [{ kind: "close_task", taskId: "task-1" }],
          },
          action_outcomes: [
            {
              action: { kind: "close_task", taskId: "task-1" },
              status: "applied",
            },
          ],
        },
      ],
      workProducts: [
        {
          id: "wp-1",
          artifact_kind: "final_artifact",
          public_url: "/deliverables/wp-1/open",
          created_at: "2026-06-12T09:00:00.000Z",
        },
      ],
      goalCompletions: [
        {
          id: "gc-1",
          goal_id: "goal-1",
          evidence: {
            workProductIds: ["wp-1"],
          },
          created_at: "2026-06-12T09:00:00.000Z",
        },
      ],
      ownerOutcomes: [
        {
          id: "outcome-1",
          goal_id: "goal-1",
          goal_completion_id: "gc-1",
          primary_open_url: "/deliverables/wp-1/open",
          primary_work_product_id: "wp-1",
          created_at: "2026-06-12T09:01:00.000Z",
        },
      ],
    });

    expect(report.counts.findings).toBe(0);
    expect(report.findings).toEqual([]);
  });
});
