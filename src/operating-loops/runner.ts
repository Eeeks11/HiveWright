export const ACTION_LOOP_STAGES = ["observe", "plan", "execute", "measure", "optimise"] as const;

export type ActionLoopStage = (typeof ACTION_LOOP_STAGES)[number];
export type ActionLoopDomain = "marketing-attention" | "sales-conversion" | "operations" | "finance" | "custom";
export type OwnerVisibleOutputPolicy = "exception-only" | "approval-request" | "weekly-summary";
export type ActionRisk = "internal" | "public" | "spend" | "customer_facing";
export type OptimiserDecision = "kill" | "keep" | "change" | "scale" | "observe_more";

export type ActionLoopStatePath = {
  kind: "business-record" | "workspace-file" | "external-system";
  path: string;
};

export type ActionLoopTemplateStage = {
  stage: ActionLoopStage;
  role: string;
  requires: ActionLoopStage[];
  writes: string[];
};

export type ActionLoopApprovalPolicy = {
  publicActionsRequireApproval?: boolean;
  spendActionsRequireApproval?: boolean;
  customerFacingActionsRequireApproval?: boolean;
  boundedAutonomyRisks?: ActionRisk[];
};

export type ActionLoopTemplate = {
  id: string;
  hiveId: string;
  domain: ActionLoopDomain;
  slug: string;
  name: string;
  objective: string;
  stages: ActionLoopTemplateStage[];
  successMetric: string;
  ownerVisibleOutputPolicy: OwnerVisibleOutputPolicy;
  defaultAutonomyLevel: number;
  approvalPolicy: ActionLoopApprovalPolicy;
};

export type ActionLoopStageStatus = "waiting_on_handoff" | "ready" | "running" | "completed" | "awaiting_approval";

export type ActionLoopStageState = {
  stage: ActionLoopStage;
  status: ActionLoopStageStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  handoffFrom?: ActionLoopStage;
};

export type RequestedAction = {
  id: string;
  risk: ActionRisk;
};

export type ApprovalRequirement = {
  actionId: string;
  risk: ActionRisk;
  reason: string;
};

export type OwnerVisibleOutput =
  | { policy: OwnerVisibleOutputPolicy; kind: "none" }
  | { policy: OwnerVisibleOutputPolicy; kind: "approval_request"; approvalsRequired: ApprovalRequirement[] }
  | { policy: OwnerVisibleOutputPolicy; kind: "weekly_summary"; summary: string };

export type ActionLoopRun = {
  templateId: string;
  hiveId: string;
  domain: ActionLoopDomain;
  cycleKey: string;
  stage: ActionLoopStage;
  status: "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
  nextStage: ActionLoopStage | null;
  inputManifest: ActionLoopStatePath[];
  outputManifest: ActionLoopStatePath[];
  stageState: ActionLoopStageState[];
  approvalPolicy: ActionLoopApprovalPolicy;
  approvalsRequired: ApprovalRequirement[];
  ownerVisibleOutput: OwnerVisibleOutput;
  optimiserDecision?: OptimiserDecision;
};

export function createActionLoopRun(input: {
  template: ActionLoopTemplate;
  cycleKey: string;
  inputManifest?: ActionLoopStatePath[];
}): ActionLoopRun {
  validateTemplate(input.template);

  return {
    templateId: input.template.id,
    hiveId: input.template.hiveId,
    domain: input.template.domain,
    cycleKey: input.cycleKey,
    stage: "observe",
    status: "queued",
    nextStage: "plan",
    inputManifest: input.inputManifest ?? [],
    outputManifest: [],
    stageState: ACTION_LOOP_STAGES.map((stage, index) => ({
      stage,
      status: index === 0 ? "ready" : "waiting_on_handoff",
    })),
    approvalPolicy: input.template.approvalPolicy,
    approvalsRequired: [],
    ownerVisibleOutput: { policy: input.template.ownerVisibleOutputPolicy, kind: "none" },
  };
}

export function completeActionLoopStage(
  run: ActionLoopRun,
  completion: {
    stage: ActionLoopStage;
    structuredOutput: Record<string, unknown>;
    outputManifest?: ActionLoopStatePath[];
    requestedActions?: RequestedAction[];
  },
): ActionLoopRun {
  if (completion.stage !== run.stage) {
    throw new Error(`Cannot complete ${completion.stage}; current loop stage is ${run.stage}.`);
  }

  const approvalsRequired = completion.stage === "execute"
    ? requiredApprovalsForActions(completion.requestedActions ?? [], run.approvalPolicy)
    : [];

  if (approvalsRequired.length > 0) {
    return {
      ...run,
      status: "awaiting_approval",
      approvalsRequired,
      ownerVisibleOutput: {
        policy: "approval-request",
        kind: "approval_request",
        approvalsRequired,
      },
      stageState: updateStage(run.stageState, completion.stage, {
        status: "awaiting_approval",
        output: completion.structuredOutput,
      }),
    };
  }

  const nextStage = nextStageAfter(completion.stage);
  const updatedStageState = updateStage(run.stageState, completion.stage, {
    status: "completed",
    output: completion.structuredOutput,
  });
  const stageState = nextStage
    ? updateStage(updatedStageState, nextStage, {
        status: "ready",
        input: completion.structuredOutput,
        handoffFrom: completion.stage,
      })
    : updatedStageState;

  const optimiserDecision = completion.stage === "optimise"
    ? parseOptimiserDecision(completion.structuredOutput.optimiserDecision)
    : run.optimiserDecision;

  return {
    ...run,
    stage: nextStage ?? "optimise",
    status: nextStage ? "running" : "completed",
    nextStage: nextStage ?? "observe",
    outputManifest: [...run.outputManifest, ...(completion.outputManifest ?? [])],
    stageState,
    approvalsRequired: [],
    optimiserDecision,
    ownerVisibleOutput: completion.stage === "optimise"
      ? {
          policy: "weekly-summary",
          kind: "weekly_summary",
          summary: "Closed-loop cycle completed; optimiser output is ready for the next observe stage.",
        }
      : run.ownerVisibleOutput,
  };
}

function validateTemplate(template: ActionLoopTemplate): void {
  const stages = template.stages.map((stage) => stage.stage);
  if (ACTION_LOOP_STAGES.some((stage) => !stages.includes(stage))) {
    throw new Error("Action loop templates must define observe, plan, execute, measure, and optimise stages.");
  }

  if (template.defaultAutonomyLevel < 0 || template.defaultAutonomyLevel > 5) {
    throw new Error("Action loop default autonomy level must be between 0 and 5.");
  }
}

function nextStageAfter(stage: ActionLoopStage): ActionLoopStage | null {
  const index = ACTION_LOOP_STAGES.indexOf(stage);
  if (index < 0) return null;
  if (stage === "optimise") return null;
  return ACTION_LOOP_STAGES[index + 1];
}

function updateStage(
  stageState: ActionLoopStageState[],
  stage: ActionLoopStage,
  patch: Partial<ActionLoopStageState>,
): ActionLoopStageState[] {
  return stageState.map((state) => (state.stage === stage ? { ...state, ...patch } : state));
}

function requiredApprovalsForActions(
  actions: RequestedAction[],
  policy: ActionLoopApprovalPolicy,
): ApprovalRequirement[] {
  return actions.flatMap((action): ApprovalRequirement[] => {
    if (action.risk === "internal") return [];
    if (action.risk === "public" && policy.publicActionsRequireApproval !== false) {
      return [{ actionId: action.id, risk: action.risk, reason: "public actions require owner approval" }];
    }
    if (action.risk === "spend" && policy.spendActionsRequireApproval !== false) {
      return [{ actionId: action.id, risk: action.risk, reason: "spend actions require owner approval" }];
    }
    if (action.risk === "customer_facing" && policy.customerFacingActionsRequireApproval !== false) {
      return [{ actionId: action.id, risk: action.risk, reason: "customer-facing actions require owner approval" }];
    }
    return [];
  });
}

function parseOptimiserDecision(value: unknown): OptimiserDecision | undefined {
  if (
    value === "kill" ||
    value === "keep" ||
    value === "change" ||
    value === "scale" ||
    value === "observe_more"
  ) {
    return value;
  }
  return undefined;
}
