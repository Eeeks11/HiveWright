import { validateCloseoutPacket, type CloseoutCanonicalMarker } from "@/closeout/packet-adapter";

export type CloseoutDriftSeverity = "info" | "warning" | "blocked";

export type CloseoutDriftKind =
  | "live_decision_after_terminal_packet"
  | "terminal_task_has_newer_unresolved_supervisor_finding"
  | "packet_missing_canonical_marker"
  | "artifact_missing_owner_handoff"
  | "supervisor_action_outcome_mismatch";

export interface CloseoutDecisionRow {
  id: string;
  status: string;
  task_id?: string | null;
  goal_id?: string | null;
  updated_at: string | Date;
}

export interface CloseoutTaskRow {
  id: string;
  status: string;
  terminal_disposition?: CloseoutCanonicalMarker | null;
  completed_at?: string | Date | null;
  updated_at: string | Date;
}

export interface CloseoutSupervisorReportRow {
  id: string;
  task_id?: string | null;
  goal_id?: string | null;
  finding_key?: string | null;
  action?: string | null;
  outcome?: string | null;
  status?: string | null;
  resolved_at?: string | Date | null;
  created_at: string | Date;
}

export interface CloseoutWorkProductRow {
  id: string;
  task_id?: string | null;
  goal_id?: string | null;
  artifact_kind?: string | null;
  owner_handoff_url?: string | null;
  owner_handoff_at?: string | Date | null;
  created_at: string | Date;
}

export interface CloseoutGoalCompletionRow {
  id: string;
  goal_id: string;
  status: string;
  evidence?: {
    workProductIds?: string[];
    primaryOpenUrl?: string | null;
  } | null;
  created_at: string | Date;
}

export interface CloseoutDriftCheckInput {
  decisions?: CloseoutDecisionRow[];
  tasks?: CloseoutTaskRow[];
  supervisorReports?: CloseoutSupervisorReportRow[];
  workProducts?: CloseoutWorkProductRow[];
  goalCompletions?: CloseoutGoalCompletionRow[];
}

export interface CloseoutDriftFinding {
  kind: CloseoutDriftKind;
  severity: CloseoutDriftSeverity;
  sourceTable: "decisions" | "tasks" | "supervisor_reports" | "work_products" | "goal_completions";
  sourceId: string;
  relatedIds: string[];
  message: string;
}

export interface CloseoutDriftReport {
  checkedAt: string;
  counts: {
    decisions: number;
    tasks: number;
    supervisorReports: number;
    workProducts: number;
    goalCompletions: number;
    findings: number;
  };
  findings: CloseoutDriftFinding[];
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled", "superseded", "unresolvable"]);
const LIVE_DECISION_STATUSES = new Set(["pending", "open", "needs_owner", "owner_action_required"]);
const FINAL_ARTIFACT_KINDS = new Set(["final_artifact", "deliverable", "owner_deliverable"]);
const TERMINAL_SUPERVISOR_OUTCOMES = new Set(["resolved", "completed", "closed", "applied", "skipped"]);

function time(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTerminalTask(task: CloseoutTaskRow): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

function hasOwnerHandoff(workProduct: CloseoutWorkProductRow): boolean {
  return Boolean(workProduct.owner_handoff_url?.trim() || workProduct.owner_handoff_at);
}

function add(findings: CloseoutDriftFinding[], finding: CloseoutDriftFinding): void {
  findings.push({ ...finding, relatedIds: Array.from(new Set(finding.relatedIds)) });
}

export function checkCloseoutDrift(input: CloseoutDriftCheckInput, now = new Date()): CloseoutDriftReport {
  const decisions = input.decisions ?? [];
  const tasks = input.tasks ?? [];
  const supervisorReports = input.supervisorReports ?? [];
  const workProducts = input.workProducts ?? [];
  const goalCompletions = input.goalCompletions ?? [];
  const findings: CloseoutDriftFinding[] = [];

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const workProductsById = new Map(workProducts.map((workProduct) => [workProduct.id, workProduct]));

  for (const task of tasks) {
    if (!isTerminalTask(task)) continue;

    const packet = validateCloseoutPacket({ marker: task.terminal_disposition ?? null });
    if (!packet.ok) {
      add(findings, {
        kind: "packet_missing_canonical_marker",
        severity: "blocked",
        sourceTable: "tasks",
        sourceId: task.id,
        relatedIds: [],
        message: `Terminal task ${task.id} is missing a valid canonical closeout marker (${packet.reason}).`,
      });
    }
  }

  for (const decision of decisions) {
    if (!LIVE_DECISION_STATUSES.has(decision.status)) continue;
    const task = decision.task_id ? tasksById.get(decision.task_id) : undefined;
    if (!task || !isTerminalTask(task) || !task.terminal_disposition) continue;
    if (time(decision.updated_at) <= Math.max(time(task.completed_at), time(task.updated_at))) continue;

    add(findings, {
      kind: "live_decision_after_terminal_packet",
      severity: "blocked",
      sourceTable: "decisions",
      sourceId: decision.id,
      relatedIds: [task.id],
      message: `Decision ${decision.id} is still live after task ${task.id} received a terminal closeout packet.`,
    });
  }

  for (const report of supervisorReports) {
    const task = report.task_id ? tasksById.get(report.task_id) : undefined;
    if (!task || !isTerminalTask(task)) continue;
    if (report.resolved_at || TERMINAL_SUPERVISOR_OUTCOMES.has(report.status ?? "")) continue;
    if (time(report.created_at) <= Math.max(time(task.completed_at), time(task.updated_at))) continue;

    add(findings, {
      kind: "terminal_task_has_newer_unresolved_supervisor_finding",
      severity: "warning",
      sourceTable: "supervisor_reports",
      sourceId: report.id,
      relatedIds: [task.id],
      message: `Supervisor report ${report.id} is newer than terminal task ${task.id} and is not resolved.`,
    });
  }

  for (const workProduct of workProducts) {
    if (!FINAL_ARTIFACT_KINDS.has(workProduct.artifact_kind ?? "")) continue;
    if (hasOwnerHandoff(workProduct)) continue;

    add(findings, {
      kind: "artifact_missing_owner_handoff",
      severity: "blocked",
      sourceTable: "work_products",
      sourceId: workProduct.id,
      relatedIds: [workProduct.task_id, workProduct.goal_id].filter((id): id is string => Boolean(id)),
      message: `Final artifact ${workProduct.id} has no owner handoff URL or handoff timestamp.`,
    });
  }

  for (const completion of goalCompletions) {
    const ids = completion.evidence?.workProductIds ?? [];
    if (completion.status !== "completed" && completion.status !== "accepted") continue;
    if (completion.evidence?.primaryOpenUrl) continue;
    const missingHandoff = ids
      .map((id) => workProductsById.get(id))
      .filter((workProduct): workProduct is CloseoutWorkProductRow => Boolean(workProduct))
      .filter((workProduct) => FINAL_ARTIFACT_KINDS.has(workProduct.artifact_kind ?? "") && !hasOwnerHandoff(workProduct));
    if (missingHandoff.length === 0) continue;

    add(findings, {
      kind: "artifact_missing_owner_handoff",
      severity: "blocked",
      sourceTable: "goal_completions",
      sourceId: completion.id,
      relatedIds: [completion.goal_id, ...missingHandoff.map((workProduct) => workProduct.id)],
      message: `Goal completion ${completion.id} references final artifacts without an owner-openable primary handoff.`,
    });
  }

  for (const report of supervisorReports) {
    if (!report.action || !report.outcome) continue;
    const actionRequiresResolution = ["close", "resolve", "accept", "mark_complete"].includes(report.action);
    const outcomeTerminal = TERMINAL_SUPERVISOR_OUTCOMES.has(report.outcome);
    if (actionRequiresResolution === outcomeTerminal) continue;

    add(findings, {
      kind: "supervisor_action_outcome_mismatch",
      severity: "warning",
      sourceTable: "supervisor_reports",
      sourceId: report.id,
      relatedIds: [report.task_id, report.goal_id].filter((id): id is string => Boolean(id)),
      message: `Supervisor report ${report.id} action/outcome mismatch: action=${report.action}, outcome=${report.outcome}.`,
    });
  }

  return {
    checkedAt: now.toISOString(),
    counts: {
      decisions: decisions.length,
      tasks: tasks.length,
      supervisorReports: supervisorReports.length,
      workProducts: workProducts.length,
      goalCompletions: goalCompletions.length,
      findings: findings.length,
    },
    findings,
  };
}
