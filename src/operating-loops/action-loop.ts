export const ACTION_LOOP_STAGES = ["observe", "plan", "execute", "measure", "optimise"] as const;

export type ActionLoopStage = (typeof ACTION_LOOP_STAGES)[number];

export type ActionLoopDomain =
  | "marketing-attention"
  | "sales-conversion"
  | "operations"
  | "finance"
  | "custom";

export type ActionLoopApprovalMode =
  | "none"
  | "approval-required"
  | "bounded-autonomy";

export type ActionLoopStatePath = {
  kind: "business-record" | "workspace-file" | "external-system";
  path: string;
};

export type ActionLoopMetadata = {
  loopId: string;
  domain: ActionLoopDomain;
  stage: ActionLoopStage;
  objective: string;
  readsFrom: ActionLoopStatePath[];
  writesTo: ActionLoopStatePath[];
  nextStage: ActionLoopStage | null;
  approvalMode: ActionLoopApprovalMode;
  successMetric: string;
  ownerVisibleOutput: "none" | "exception-only" | "approval-request" | "summary";
};

export type ActionLoopScheduleTemplate = {
  kind: string;
  assignedTo: string;
  title: string;
  brief: string;
  qaRequired?: boolean;
  priority?: number;
  actionLoop: ActionLoopMetadata;
};

export type BuildActionLoopInput = {
  hiveName: string;
  loopId: string;
  domain: ActionLoopDomain;
  objective: string;
  stateNamespace: string;
  cronByStage?: Partial<Record<ActionLoopStage, string>>;
  assignedToByStage?: Partial<Record<ActionLoopStage, string>>;
  approvalModeByStage?: Partial<Record<ActionLoopStage, ActionLoopApprovalMode>>;
};

export type ActionLoopScheduleDefinition = {
  key: string;
  title: string;
  kind: string;
  cronExpression: string;
  template: ActionLoopScheduleTemplate;
};

const DEFAULT_CRON_BY_STAGE: Record<ActionLoopStage, string> = {
  observe: "5 6 * * *",
  plan: "20 6 * * *",
  execute: "40 6 * * *",
  measure: "10 7 * * *",
  optimise: "25 7 * * *",
};

const DEFAULT_ROLE_BY_STAGE: Record<ActionLoopStage, string> = {
  observe: "researcher",
  plan: "strategist",
  execute: "executor",
  measure: "analyst",
  optimise: "strategist",
};

const DEFAULT_APPROVAL_BY_STAGE: Record<ActionLoopStage, ActionLoopApprovalMode> = {
  observe: "none",
  plan: "none",
  execute: "approval-required",
  measure: "none",
  optimise: "bounded-autonomy",
};

function nextStage(stage: ActionLoopStage): ActionLoopStage | null {
  const index = ACTION_LOOP_STAGES.indexOf(stage);
  return index === ACTION_LOOP_STAGES.length - 1 ? "observe" : ACTION_LOOP_STAGES[index + 1];
}

function titleCaseStage(stage: ActionLoopStage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function statePath(stateNamespace: string, name: string): ActionLoopStatePath {
  return { kind: "business-record", path: `${stateNamespace}/${name}.json` };
}

function readsForStage(stateNamespace: string, stage: ActionLoopStage): ActionLoopStatePath[] {
  switch (stage) {
    case "observe":
      return [statePath(stateNamespace, "profile"), statePath(stateNamespace, "last-results")];
    case "plan":
      return [statePath(stateNamespace, "observations"), statePath(stateNamespace, "playbook")];
    case "execute":
      return [statePath(stateNamespace, "plan"), statePath(stateNamespace, "approval-queue")];
    case "measure":
      return [statePath(stateNamespace, "execution-log"), statePath(stateNamespace, "baseline")];
    case "optimise":
      return [statePath(stateNamespace, "results"), statePath(stateNamespace, "plan")];
  }
}

function writesForStage(stateNamespace: string, stage: ActionLoopStage): ActionLoopStatePath[] {
  switch (stage) {
    case "observe":
      return [statePath(stateNamespace, "observations")];
    case "plan":
      return [statePath(stateNamespace, "plan"), statePath(stateNamespace, "approval-queue")];
    case "execute":
      return [statePath(stateNamespace, "execution-log")];
    case "measure":
      return [statePath(stateNamespace, "results")];
    case "optimise":
      return [statePath(stateNamespace, "next-actions"), statePath(stateNamespace, "playbook-notes")];
  }
}

function ownerVisibleOutputForStage(stage: ActionLoopStage): ActionLoopMetadata["ownerVisibleOutput"] {
  if (stage === "execute") return "approval-request";
  if (stage === "measure") return "summary";
  return "exception-only";
}

export function buildActionLoopScheduleDefinitions(input: BuildActionLoopInput): ActionLoopScheduleDefinition[] {
  return ACTION_LOOP_STAGES.map((stage) => {
    const kind = `${input.domain}.${stage}`;
    const stageTitle = `${titleCaseStage(stage)} ${input.domain.replace("-", " ")} loop`;
    const assignedTo = input.assignedToByStage?.[stage] ?? DEFAULT_ROLE_BY_STAGE[stage];
    const approvalMode = input.approvalModeByStage?.[stage] ?? DEFAULT_APPROVAL_BY_STAGE[stage];

    return {
      key: `${input.loopId}.${stage}`,
      title: stageTitle,
      kind,
      cronExpression: input.cronByStage?.[stage] ?? DEFAULT_CRON_BY_STAGE[stage],
      template: {
        kind,
        assignedTo,
        title: stageTitle,
        priority: stage === "execute" ? 2 : 3,
        qaRequired: stage === "execute",
        brief: buildStageBrief({ ...input, stage, assignedTo, approvalMode }),
        actionLoop: {
          loopId: input.loopId,
          domain: input.domain,
          stage,
          objective: input.objective,
          readsFrom: readsForStage(input.stateNamespace, stage),
          writesTo: writesForStage(input.stateNamespace, stage),
          nextStage: nextStage(stage),
          approvalMode,
          successMetric: successMetricForDomain(input.domain),
          ownerVisibleOutput: ownerVisibleOutputForStage(stage),
        },
      },
    };
  });
}

function successMetricForDomain(domain: ActionLoopDomain): string {
  switch (domain) {
    case "marketing-attention":
      return "qualified attention generated from approved campaigns";
    case "sales-conversion":
      return "lead-to-booking/sale conversion improvement";
    case "finance":
      return "validated financial record throughput and exception reduction";
    case "operations":
      return "completed operational next actions without owner re-prompting";
    case "custom":
      return "loop-specific target metric";
  }
}

function buildStageBrief(input: BuildActionLoopInput & {
  stage: ActionLoopStage;
  assignedTo: string;
  approvalMode: ActionLoopApprovalMode;
}): string {
  const base = `${input.hiveName} ${input.domain} action loop. Objective: ${input.objective}. This is the ${input.stage} stage of a closed observe-plan-execute-measure-optimise workflow.`;

  switch (input.stage) {
    case "observe":
      return `${base} Gather fresh evidence and write structured observations only; do not stop at a narrative report.`;
    case "plan":
      return `${base} Read the latest observations and create a small executable plan with explicit actions, owners, required approvals, and measurable expected outcomes.`;
    case "execute":
      return `${base} Execute only approved or bounded actions from the plan. If an action needs owner approval, create an approval request instead of improvising.`;
    case "measure":
      return `${base} Measure executed actions against the success metric and write results in structured form for the optimiser.`;
    case "optimise":
      return `${base} Decide what to kill, keep, change, or scale. Write next actions for the next observe/plan cycle rather than producing a dead-end report.`;
  }
}
