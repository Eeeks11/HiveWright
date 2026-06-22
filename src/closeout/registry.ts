import type { FindingKind } from "@/supervisor/types";

export const TERMINAL_STATUSES = [
  "closed",
  "closed_with_follow_up",
  "superseded",
  "escalated_owner",
  "rejected_insufficient_evidence",
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const FINAL_DISPOSITION_LABELS = [
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
] as const;

export type FinalDispositionLabel = (typeof FINAL_DISPOSITION_LABELS)[number];

export const CLOSURE_SCOPES = [
  "task",
  "goal",
  "decision",
  "supervisor_finding",
  "work_product",
  "github_issue",
  "packet_family",
  "hive",
] as const;

export type ClosureScope = (typeof CLOSURE_SCOPES)[number];

export const DECISION_BOUNDARIES = [
  "autonomous_safe",
  "ea_review_required",
  "owner_pending",
  "owner_resolved",
  "operator_review_required",
  "external_state_only",
] as const;

export type DecisionBoundary = (typeof DECISION_BOUNDARIES)[number];

export const CLOSEOUT_FINDING_TYPES = [
  "unsatisfied_completion",
  "stalled_task",
  "dormant_goal",
  "goal_lifecycle_gap",
  "aging_decision",
  "recurring_failure",
  "orphan_output",
  "unstarted_goal",
  "goal_appears_complete",
] as const satisfies readonly FindingKind[];

export type CloseoutFindingType = (typeof CLOSEOUT_FINDING_TYPES)[number];

export const STORAGE_ROOT_FAMILIES = [
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
] as const;

export type StorageRootFamily = (typeof STORAGE_ROOT_FAMILIES)[number];

export type KnownLegacyTerminalDispositionKind =
  | "reference_only_output"
  | "reference_only_wrapper_superseded"
  | "improvement_scan_backlog_disposition";

export interface TerminalDispositionCompatibility {
  terminalStatus: TerminalStatus;
  finalDispositionLabel?: FinalDispositionLabel;
  closureScope: ClosureScope;
  decisionBoundary: DecisionBoundary;
  storageRootFamily: StorageRootFamily;
  canAutoClose: boolean;
}

export const TERMINAL_DISPOSITION_COMPATIBILITY: Record<
  KnownLegacyTerminalDispositionKind,
  TerminalDispositionCompatibility
> = {
  reference_only_output: {
    terminalStatus: "closed",
    finalDispositionLabel: "reference_only_output",
    closureScope: "task",
    decisionBoundary: "autonomous_safe",
    storageRootFamily: "db_task_terminal_disposition",
    canAutoClose: true,
  },
  reference_only_wrapper_superseded: {
    terminalStatus: "superseded",
    finalDispositionLabel: "reference_only_wrapper_superseded",
    closureScope: "task",
    decisionBoundary: "autonomous_safe",
    storageRootFamily: "db_task_terminal_disposition",
    canAutoClose: true,
  },
  improvement_scan_backlog_disposition: {
    terminalStatus: "closed_with_follow_up",
    finalDispositionLabel: "github_issue_backlog_open",
    closureScope: "github_issue",
    decisionBoundary: "external_state_only",
    storageRootFamily: "db_task_terminal_disposition",
    canAutoClose: true,
  },
} as const;

export const UNKNOWN_LEGACY_TERMINAL_DISPOSITION: TerminalDispositionCompatibility = {
  terminalStatus: "rejected_insufficient_evidence",
  closureScope: "task",
  decisionBoundary: "operator_review_required",
  storageRootFamily: "db_task_terminal_disposition",
  canAutoClose: false,
} as const;

export function isKnownLegacyTerminalDispositionKind(
  kind: string | null | undefined,
): kind is KnownLegacyTerminalDispositionKind {
  return kind === "reference_only_output"
    || kind === "reference_only_wrapper_superseded"
    || kind === "improvement_scan_backlog_disposition";
}

export function resolveTerminalDispositionCompatibility(
  kind: string | null | undefined,
): TerminalDispositionCompatibility {
  if (isKnownLegacyTerminalDispositionKind(kind)) {
    return TERMINAL_DISPOSITION_COMPATIBILITY[kind];
  }

  return UNKNOWN_LEGACY_TERMINAL_DISPOSITION;
}
