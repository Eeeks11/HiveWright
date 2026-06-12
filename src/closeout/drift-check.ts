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

export interface CloseoutSupervisorAction {
  kind?: string | null;
  taskId?: string | null;
  goalId?: string | null;
}

export interface CloseoutSupervisorOutcome {
  action?: CloseoutSupervisorAction | null;
  status?: string | null;
}

export interface CloseoutSupervisorReportRow {
  id: string;
  agent_task_id?: string | null;
  actions?: {
    actions?: CloseoutSupervisorAction[];
    findings_addressed?: string[];
  } | null;
  action_outcomes?: CloseoutSupervisorOutcome[] | null;
  ran_at: string | Date;
}

export interface CloseoutWorkProductRow {
  id: string;
  task_id?: string | null;
  goal_id?: string | null;
  artifact_kind?: string | null;
  public_url?: string | null;
  source_url?: string | null;
  file_path?: string | null;
  created_at: string | Date;
}

export interface CloseoutGoalCompletionRow {
  id: string;
  goal_id: string;
  evidence?: {
    workProductIds?: string[];
  } | null;
  created_at: string | Date;
}

export interface CloseoutOwnerOutcomeRow {
  id: string;
  goal_id: string;
  goal_completion_id: string;
  primary_open_url?: string | null;
  primary_work_product_id?: string | null;
  created_at: string | Date;
}

export interface CloseoutDriftCheckInput {
  decisions?: CloseoutDecisionRow[];
  tasks?: CloseoutTaskRow[];
  supervisorReports?: CloseoutSupervisorReportRow[];
  workProducts?: CloseoutWorkProductRow[];
  goalCompletions?: CloseoutGoalCompletionRow[];
  ownerOutcomes?: CloseoutOwnerOutcomeRow[];
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
    ownerOutcomes: number;
    findings: number;
  };
  findings: CloseoutDriftFinding[];
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled", "superseded", "unresolvable"]);
const LIVE_DECISION_STATUSES = new Set(["pending", "open", "needs_owner", "owner_action_required"]);
const FINAL_ARTIFACT_KINDS = new Set(["final_artifact", "deliverable", "owner_deliverable"]);
const ACTION_KINDS_REQUIRING_RESOLUTION = new Set(["close_task", "mark_unresolvable"]);
const TERMINAL_SUPERVISOR_OUTCOME_STATUSES = new Set(["applied", "skipped"]);

function time(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTerminalTask(task: CloseoutTaskRow): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

function hasOwnerOpenableRoute(workProduct: CloseoutWorkProductRow): boolean {
  return Boolean(workProduct.public_url?.trim() || workProduct.source_url?.trim() || workProduct.file_path?.trim());
}

function outcomeMatchesAction(outcome: CloseoutSupervisorOutcome, action: CloseoutSupervisorAction): boolean {
  if (!outcome.action) return false;
  return (
    outcome.action.kind === action.kind &&
    (action.taskId ? outcome.action.taskId === action.taskId : true) &&
    (action.goalId ? outcome.action.goalId === action.goalId : true)
  );
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
  const ownerOutcomes = input.ownerOutcomes ?? [];
  const findings: CloseoutDriftFinding[] = [];

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const workProductsById = new Map(workProducts.map((workProduct) => [workProduct.id, workProduct]));
  const ownerOutcomesByGoalCompletionId = new Map(ownerOutcomes.map((outcome) => [outcome.goal_completion_id, outcome]));

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
    const task = report.agent_task_id ? tasksById.get(report.agent_task_id) : undefined;
    if (!task || !isTerminalTask(task)) continue;
    const actionOutcomes = report.action_outcomes ?? [];
    const unresolvedActions = (report.actions?.actions ?? []).filter((action) => {
      if (!ACTION_KINDS_REQUIRING_RESOLUTION.has(action.kind ?? "")) return false;
      const matchingOutcome = actionOutcomes.find((outcome) => outcomeMatchesAction(outcome, action));
      return !matchingOutcome || !TERMINAL_SUPERVISOR_OUTCOME_STATUSES.has(matchingOutcome.status ?? "");
    });
    if (unresolvedActions.length === 0) continue;
    if (time(report.ran_at) <= Math.max(time(task.completed_at), time(task.updated_at))) continue;

    add(findings, {
      kind: "terminal_task_has_newer_unresolved_supervisor_finding",
      severity: "warning",
      sourceTable: "supervisor_reports",
      sourceId: report.id,
      relatedIds: [task.id],
      message: `Supervisor report ${report.id} is newer than terminal task ${task.id} and has ${unresolvedActions.length} unresolved terminal action(s).`,
    });
  }

  for (const workProduct of workProducts) {
    if (!FINAL_ARTIFACT_KINDS.has(workProduct.artifact_kind ?? "")) continue;
    if (hasOwnerOpenableRoute(workProduct)) continue;

    add(findings, {
      kind: "artifact_missing_owner_handoff",
      severity: "blocked",
      sourceTable: "work_products",
      sourceId: workProduct.id,
      relatedIds: [workProduct.task_id, workProduct.goal_id].filter((id): id is string => Boolean(id)),
      message: `Final artifact ${workProduct.id} has no owner-openable public URL, source URL, or deliverable file path.`,
    });
  }

  for (const completion of goalCompletions) {
    const ids = completion.evidence?.workProductIds ?? [];
    const ownerOutcome = ownerOutcomesByGoalCompletionId.get(completion.id);
    if (ownerOutcome?.primary_open_url) continue;
    const missingHandoff = ids
      .map((id) => workProductsById.get(id))
      .filter((workProduct): workProduct is CloseoutWorkProductRow => Boolean(workProduct))
      .filter((workProduct) => FINAL_ARTIFACT_KINDS.has(workProduct.artifact_kind ?? "") && !hasOwnerOpenableRoute(workProduct));
    if (missingHandoff.length === 0) continue;

    add(findings, {
      kind: "artifact_missing_owner_handoff",
      severity: "blocked",
      sourceTable: "goal_completions",
      sourceId: completion.id,
      relatedIds: [completion.goal_id, ...missingHandoff.map((workProduct) => workProduct.id)],
      message: `Goal completion ${completion.id} references final artifacts without an owner-openable primary outcome or artifact route.`,
    });
  }

  for (const report of supervisorReports) {
    for (const action of report.actions?.actions ?? []) {
      if (!ACTION_KINDS_REQUIRING_RESOLUTION.has(action.kind ?? "")) continue;
      const matchingOutcome = (report.action_outcomes ?? []).find((outcome) => outcomeMatchesAction(outcome, action));
      if (matchingOutcome && TERMINAL_SUPERVISOR_OUTCOME_STATUSES.has(matchingOutcome.status ?? "")) continue;

      add(findings, {
        kind: "supervisor_action_outcome_mismatch",
        severity: "warning",
        sourceTable: "supervisor_reports",
        sourceId: report.id,
        relatedIds: [action.taskId, action.goalId].filter((id): id is string => Boolean(id)),
        message: `Supervisor report ${report.id} action/outcome mismatch: action=${action.kind ?? "unknown"}, outcome=${matchingOutcome?.status ?? "missing"}.`,
      });
    }
  }

  return {
    checkedAt: now.toISOString(),
    counts: {
      decisions: decisions.length,
      tasks: tasks.length,
      supervisorReports: supervisorReports.length,
      workProducts: workProducts.length,
      goalCompletions: goalCompletions.length,
      ownerOutcomes: ownerOutcomes.length,
      findings: findings.length,
    },
    findings,
  };
}
