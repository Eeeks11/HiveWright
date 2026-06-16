import { buildConnectorDataSources, type ConnectorSourceInput } from "@/operating-systems/connector-data-sources";

export type SalesFunnelStageKey =
  | "traffic"
  | "lead"
  | "response"
  | "qualification"
  | "booking"
  | "show_up"
  | "sale"
  | "review_referral_repeat";

export type SalesWorkflow = "reactivation" | "lead_follow_up" | "review_referral" | "missed_call_recovery" | "sales_training";
export type SalesActionApprovalStatus = "pending_owner_approval" | "approved" | "rejected";
export type SalesActionExecutionStatus = "draft" | "queued" | "executed" | "blocked";
export type SalesConnector = "manual_queue" | "crm" | "email" | "sms" | "phone" | "booking";

const SALES_STAGE_ORDER = ["observe", "plan", "execute", "measure", "optimise"] as const;

const FUNNEL_STAGES: Array<{ key: SalesFunnelStageKey; label: string; metricKey: keyof SalesFunnelMetrics }> = [
  { key: "traffic", label: "Traffic", metricKey: "traffic" },
  { key: "lead", label: "Lead", metricKey: "leads" },
  { key: "response", label: "Response", metricKey: "responded" },
  { key: "qualification", label: "Qualification", metricKey: "qualified" },
  { key: "booking", label: "Booking", metricKey: "booked" },
  { key: "show_up", label: "Show-up", metricKey: "showed" },
  { key: "sale", label: "Sale", metricKey: "sold" },
  { key: "review_referral_repeat", label: "Review / referral / repeat", metricKey: "reviewReferralRepeat" },
];

const WORKFLOW_ORDER: SalesWorkflow[] = ["lead_follow_up", "missed_call_recovery", "reactivation", "review_referral", "sales_training"];

export type SalesFunnelMetrics = {
  traffic: number;
  leads: number;
  responded: number;
  qualified: number;
  booked: number;
  showed: number;
  sold: number;
  reviews: number;
  referrals: number;
  repeatPurchases: number;
  reviewReferralRepeat?: number;
};

export type SalesSegment = {
  id: string;
  hiveId: string;
  name: string;
  source: "manual_import" | "business_records" | "connector";
  customerType: "lead" | "customer" | "dormant_customer";
};

export type SalesFunnelStage = {
  key: SalesFunnelStageKey;
  label: string;
  count: number;
  conversionFromPrevious: number | null;
};

export type SalesBottleneck = {
  fromStage: SalesFunnelStageKey;
  toStage: SalesFunnelStageKey;
  conversionRate: number;
  lostCount: number;
  severity: "low" | "medium" | "high";
};

export type SalesFunnel = {
  id: string;
  hiveId: string;
  domain: "sales-conversion";
  segmentId: string;
  goal: string;
  stages: SalesFunnelStage[];
  biggestLeak: SalesBottleneck;
  capturedAt: string;
};

export type SalesActionPlan = {
  id: string;
  hiveId: string;
  funnelId: string;
  bottleneck: SalesBottleneck;
  status: "draft" | "approval" | "running" | "completed";
  boundedBy: "one owner-approved sales conversion fix";
  approvalPolicy: { outboundCustomerActions: "owner_approval_required" };
  nextMeasurement: string;
  createdAt: string;
};

export type SalesActionDraft = {
  id: string;
  hiveId: string;
  actionPlanId: string;
  workflow: SalesWorkflow;
  title: string;
  draftBody: string;
  approvalStatus: SalesActionApprovalStatus;
  executionStatus: SalesActionExecutionStatus;
  ownerDecision?: {
    ownerId: string;
    decision: "approved" | "rejected";
    reason?: string;
    decidedAt: string;
  };
};

export type SalesExecutionLog = {
  id: string;
  hiveId: string;
  actionPlanId: string;
  actionDraftId: string;
  workflow: SalesWorkflow;
  connector: SalesConnector;
  executedAt: string;
  trace: ["funnel_observed", "bottleneck_identified", "owner_approved", "execution_logged"];
};

export type SalesOperatingPlan = {
  segment: SalesSegment;
  funnel: SalesFunnel;
  bottleneck: SalesBottleneck;
  actionPlan: SalesActionPlan;
  actionDrafts: SalesActionDraft[];
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "sales";
}

function stableId(...parts: string[]) {
  return parts.map((part) => slugify(part)).filter(Boolean).join("_");
}

function ratio(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function severityFor(conversionRate: number): SalesBottleneck["severity"] {
  if (conversionRate < 0.5) return "high";
  if (conversionRate < 0.75) return "medium";
  return "low";
}

function normalizedMetrics(metrics: SalesFunnelMetrics): Required<SalesFunnelMetrics> {
  return {
    ...metrics,
    reviewReferralRepeat: metrics.reviewReferralRepeat ?? metrics.reviews + metrics.referrals + metrics.repeatPurchases,
  };
}

export function identifySalesBottleneck(stages: SalesFunnelStage[]): SalesBottleneck {
  const leaks = stages.slice(1).map((stage, index) => {
    const previous = stages[index];
    const conversionRate = stage.conversionFromPrevious ?? 0;
    return {
      fromStage: previous.key,
      toStage: stage.key,
      conversionRate,
      lostCount: Math.max(0, previous.count - stage.count),
      severity: severityFor(conversionRate),
    } satisfies SalesBottleneck;
  });

  const conversionLeaks = leaks.filter((leak) => leak.fromStage !== "traffic");
  return conversionLeaks.sort((a, b) => b.lostCount - a.lostCount || a.conversionRate - b.conversionRate)[0] ?? leaks[0];
}

function createFunnelStages(metrics: SalesFunnelMetrics): SalesFunnelStage[] {
  const normalized = normalizedMetrics(metrics);
  return FUNNEL_STAGES.map((stage, index) => {
    const count = normalized[stage.metricKey];
    const previousCount = index === 0 ? null : normalized[FUNNEL_STAGES[index - 1].metricKey];
    return {
      key: stage.key,
      label: stage.label,
      count,
      conversionFromPrevious: previousCount === null ? null : ratio(count, previousCount),
    };
  });
}

function workflowTitle(workflow: SalesWorkflow, bottleneck: SalesBottleneck) {
  const leak = `${bottleneck.fromStage.replaceAll("_", " ")} → ${bottleneck.toStage.replaceAll("_", " ")}`;
  switch (workflow) {
    case "lead_follow_up":
      return `Follow up leads leaking at ${leak}`;
    case "missed_call_recovery":
      return `Recover missed-call opportunities at ${leak}`;
    case "reactivation":
      return `Reactivate dormant opportunities linked to ${leak}`;
    case "review_referral":
      return `Request reviews and referrals after ${leak}`;
    case "sales_training":
      return `Coach sales handling for ${leak}`;
  }
}

export function createSalesOperatingPlan(input: {
  hiveId: string;
  goal: string;
  segment: Omit<SalesSegment, "id" | "hiveId">;
  metrics: SalesFunnelMetrics;
  now?: Date;
}): SalesOperatingPlan {
  const now = input.now ?? new Date();
  const capturedAt = now.toISOString();
  const segment: SalesSegment = {
    id: stableId("sales-segment", input.hiveId, input.segment.name),
    hiveId: input.hiveId,
    ...input.segment,
  };
  const stages = createFunnelStages(input.metrics);
  const biggestLeak = identifySalesBottleneck(stages);
  const funnelId = stableId("sales-funnel", input.hiveId, input.goal, capturedAt);
  const actionPlanId = stableId("sales-action-plan", funnelId, biggestLeak.toStage);
  const actionPlan: SalesActionPlan = {
    id: actionPlanId,
    hiveId: input.hiveId,
    funnelId,
    bottleneck: biggestLeak,
    status: "draft",
    boundedBy: "one owner-approved sales conversion fix",
    approvalPolicy: { outboundCustomerActions: "owner_approval_required" },
    nextMeasurement: "measure conversion movement before optimising the next sales cycle",
    createdAt: capturedAt,
  };

  return {
    segment,
    funnel: {
      id: funnelId,
      hiveId: input.hiveId,
      domain: "sales-conversion",
      segmentId: segment.id,
      goal: input.goal,
      stages,
      biggestLeak,
      capturedAt,
    },
    bottleneck: biggestLeak,
    actionPlan,
    actionDrafts: WORKFLOW_ORDER.map((workflow) => ({
      id: stableId(actionPlanId, workflow),
      hiveId: input.hiveId,
      actionPlanId,
      workflow,
      title: workflowTitle(workflow, biggestLeak),
      draftBody: `Bounded ${workflow.replaceAll("_", " ")} draft for ${segment.name}. Requires owner approval before any outbound customer action.`,
      approvalStatus: "pending_owner_approval",
      executionStatus: "draft",
    })),
  };
}

export function approveSalesActionDraft(input: {
  actionDraft: SalesActionDraft;
  decision: "approved" | "rejected";
  ownerId: string;
  reason?: string;
  now?: Date;
}): SalesActionDraft {
  return {
    ...input.actionDraft,
    approvalStatus: input.decision === "approved" ? "approved" : "rejected",
    executionStatus: input.decision === "approved" ? "queued" : "blocked",
    ownerDecision: {
      ownerId: input.ownerId,
      decision: input.decision,
      reason: input.reason,
      decidedAt: (input.now ?? new Date()).toISOString(),
    },
  };
}

export function createSalesExecutionLog(input: {
  actionDraft: SalesActionDraft;
  connector: SalesConnector;
  now?: Date;
}): SalesExecutionLog {
  if (input.actionDraft.approvalStatus !== "approved") {
    throw new Error("Sales execution requires owner approval before outbound customer-facing actions are logged or queued.");
  }
  const executedAt = (input.now ?? new Date()).toISOString();
  return {
    id: stableId("sales-execution", input.actionDraft.id, executedAt),
    hiveId: input.actionDraft.hiveId,
    actionPlanId: input.actionDraft.actionPlanId,
    actionDraftId: input.actionDraft.id,
    workflow: input.actionDraft.workflow,
    connector: input.connector,
    executedAt,
    trace: ["funnel_observed", "bottleneck_identified", "owner_approved", "execution_logged"],
  };
}

export function buildSalesDashboardSnapshot(input: {
  funnels: SalesFunnel[];
  actionPlans: SalesActionPlan[];
  actionDrafts: SalesActionDraft[];
  executionLogs: SalesExecutionLog[];
  connectorSources?: ConnectorSourceInput[];
}) {
  const executionCounts = new Map<string, number>();
  for (const log of input.executionLogs) {
    executionCounts.set(log.actionPlanId, (executionCounts.get(log.actionPlanId) ?? 0) + 1);
  }

  return {
    leakageMap: input.funnels.map((funnel) => ({
      id: funnel.id,
      hiveId: funnel.hiveId,
      goal: funnel.goal,
      stages: funnel.stages,
      biggestLeak: funnel.biggestLeak,
      capturedAt: funnel.capturedAt,
    })),
    activeActionPlans: input.actionPlans.filter((plan) => plan.status !== "completed"),
    pendingApprovals: input.actionDrafts.filter((draft) => draft.approvalStatus === "pending_owner_approval"),
    queuedActions: input.actionDrafts.filter((draft) => draft.approvalStatus === "approved" && draft.executionStatus === "queued"),
    dataSources: buildConnectorDataSources("sales-conversion", input.connectorSources),
    results: input.actionPlans.map((plan) => ({
      actionPlanId: plan.id,
      funnelId: plan.funnelId,
      bottleneck: plan.bottleneck,
      executionCount: executionCounts.get(plan.id) ?? 0,
      nextLoopInput: plan.nextMeasurement,
    })),
    loopState: { stageOrder: [...SALES_STAGE_ORDER] },
  };
}
