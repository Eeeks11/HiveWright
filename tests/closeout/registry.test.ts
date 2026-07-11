import { describe, expect, it } from "vitest";
import {
  CLOSEOUT_FINDING_TYPES,
  CLOSURE_SCOPES,
  DECISION_BOUNDARIES,
  FINAL_DISPOSITION_LABELS,
  STORAGE_ROOT_FAMILIES,
  TERMINAL_DISPOSITION_COMPATIBILITY,
  TERMINAL_STATUSES,
  isKnownLegacyTerminalDispositionKind,
  resolveTerminalDispositionCompatibility,
} from "@/closeout/registry";

describe("closeout registry", () => {
  it("exports the canonical terminal statuses in stable order", () => {
    expect(TERMINAL_STATUSES).toEqual([
      "closed",
      "closed_with_follow_up",
      "superseded",
      "escalated_owner",
      "rejected_insufficient_evidence",
    ]);
  });

  it("exports the canonical final disposition labels in stable order", () => {
    expect(FINAL_DISPOSITION_LABELS).toEqual([
      "reference_only_output",
      "reference_only_wrapper_superseded",
      "unsatisfied_completion_resolved",
      "orphan_output_attributed",
      "follow_up_spawned",
      "owner_decision_required",
      "owner_decision_resolved",
      "malformed_supervisor_escalated",
      "task_marked_unresolvable",
      "goal_completion_accepted",
      "github_issue_backlog_open",
      "github_issue_landed_verified",
      "github_issue_stale_or_drifted",
    ]);
  });

  it("exports canonical closeout dimensions", () => {
    expect(CLOSURE_SCOPES).toEqual([
      "task",
      "goal",
      "decision",
      "supervisor_finding",
      "work_product",
      "github_issue",
      "packet_family",
      "hive",
    ]);
    expect(DECISION_BOUNDARIES).toEqual([
      "autonomous_safe",
      "ea_review_required",
      "owner_pending",
      "owner_resolved",
      "operator_review_required",
      "external_state_only",
    ]);
    expect(STORAGE_ROOT_FAMILIES).toEqual([
      "db_task_terminal_disposition",
      "db_supervisor_report",
      "db_decision",
      "db_work_product",
      "db_goal_completion",
      "workspace_deliverable_manifest",
      "workspace_work_product_manifest",
      "business_governance_packet",
      "business_work_product_packet",
      "github_issue",
    ]);
  });

  it("mirrors current supervisor finding types", () => {
    expect(CLOSEOUT_FINDING_TYPES).toEqual([
      "unsatisfied_completion",
      "stalled_task",
      "dormant_goal",
      "goal_lifecycle_gap",
      "aging_decision",
      "recurring_failure",
      "orphan_output",
      "unstarted_goal",
      "goal_appears_complete",
    ]);
  });

  it("maps reference-only output dispositions to closed task records", () => {
    expect(TERMINAL_DISPOSITION_COMPATIBILITY.reference_only_output).toEqual({
      terminalStatus: "closed",
      finalDispositionLabel: "reference_only_output",
      closureScope: "task",
      decisionBoundary: "autonomous_safe",
      storageRootFamily: "db_task_terminal_disposition",
      canAutoClose: true,
    });
  });

  it("maps reference-only wrapper dispositions to superseded task records", () => {
    expect(TERMINAL_DISPOSITION_COMPATIBILITY.reference_only_wrapper_superseded).toEqual({
      terminalStatus: "superseded",
      finalDispositionLabel: "reference_only_wrapper_superseded",
      closureScope: "task",
      decisionBoundary: "autonomous_safe",
      storageRootFamily: "db_task_terminal_disposition",
      canAutoClose: true,
    });
  });

  it("detects known legacy terminal disposition kinds", () => {
    expect(isKnownLegacyTerminalDispositionKind("reference_only_output")).toBe(true);
    expect(isKnownLegacyTerminalDispositionKind("reference_only_wrapper_superseded")).toBe(true);
    expect(isKnownLegacyTerminalDispositionKind("legacy_markdown_packet")).toBe(false);
    expect(isKnownLegacyTerminalDispositionKind(undefined)).toBe(false);
  });

  it("does not auto-close unknown legacy disposition kinds", () => {
    expect(resolveTerminalDispositionCompatibility("legacy_markdown_packet")).toEqual({
      terminalStatus: "rejected_insufficient_evidence",
      closureScope: "task",
      decisionBoundary: "operator_review_required",
      storageRootFamily: "db_task_terminal_disposition",
      canAutoClose: false,
    });
  });
});
