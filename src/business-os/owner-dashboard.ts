export type BusinessMode = "new_business" | "existing_business";

export type BusinessOsOwnerDashboardInput = {
  profile: {
    id: string;
    businessMode: BusinessMode;
    businessName: string;
    stage: string | null;
    summary: string | null;
    ownerGoals: string[];
    approvalPolicy: Record<string, unknown>;
    aiSpendBudget: Record<string, unknown>;
    autonomyPolicy: Record<string, unknown>;
    updatedAt?: string | Date | null;
  };
  setupProfile: {
    idea?: string | null;
    customerSegments?: string[];
    offers?: string[];
    legalComplianceChecklist?: string[];
    toolStack?: string[];
    rolesAndSops?: string[];
    updatedAt?: string | Date | null;
  } | null;
  auditProfile: {
    auditStatus: string;
    overallReadinessScore: number | null;
    overallConfidence: string | null;
    auditScope: string[];
    evidenceSources: Array<Record<string, unknown>>;
    knownUnknowns: string[];
    completedAt?: string | Date | null;
    updatedAt?: string | Date | null;
  } | null;
  readiness: ReadinessRow[];
  gaps: GapRow[];
  recommendations: RecommendationRow[];
  actions: BusinessActionRow[];
  agentActivity: AgentActivityRow[];
  since?: string | Date | null;
};

export type ReadinessRow = {
  systemKey: string;
  systemLabel: string;
  readinessScore: number;
  maturityLevel: string | null;
  confidence: string | null;
  evidenceRefs: Array<Record<string, unknown>>;
  summary: string | null;
  updatedAt?: string | Date | null;
};

export type GapRow = {
  title: string;
  severity: string | null;
  status: string;
  systemKey?: string | null;
  confidence: string | null;
  evidenceRefs: Array<Record<string, unknown>>;
};

export type RecommendationRow = {
  title: string;
  rationale: string;
  expectedOutcome: string | null;
  riskLevel: string | null;
  requiresOwnerApproval: boolean;
  status: string;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type BusinessActionRow = {
  title: string;
  brief: string;
  status: string;
  priority: number;
  riskLevel: string | null;
  approvalRequired: boolean;
  expectedOutcome: string | null;
  measurementPlan: Record<string, unknown>;
  sourceRefs: Array<Record<string, unknown>>;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

export type AgentActivityRow = {
  title: string;
  summary: string | null;
  status: string;
  role: string | null;
  evidenceUrl: string | null;
  updatedAt?: string | Date | null;
};

export type BusinessOsOwnerDashboard = ReturnType<typeof deriveBusinessOsOwnerDashboard>;

const TERMINAL_ACTION_STATUSES = new Set(["completed", "cancelled", "failed"]);
const ACTIVE_ACTION_STATUSES = new Set(["draft", "queued", "awaiting_approval", "approved", "running", "blocked"]);
const WEAK_MATURITY_LEVELS = new Set(["missing", "ad_hoc"]);

function asTime(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function countTruthy(values: unknown[]) {
  return values.filter((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return !!value;
  }).length;
}

function evidenceLabel(ref: Record<string, unknown>): string {
  for (const key of ["label", "title", "source", "url", "id"]) {
    const value = ref[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Evidence recorded";
}

function formatBudget(value: Record<string, unknown>) {
  const capCents = typeof value.capCents === "number" ? value.capCents : null;
  const window = typeof value.window === "string" ? value.window.replace("_", " ") : "configured window";
  if (capCents === null) return "AI spend budget configured";
  return `$${(capCents / 100).toFixed(0)} ${window} AI spend budget`;
}

function sortedActiveActions(actions: BusinessActionRow[]) {
  return [...actions]
    .filter((action) => ACTIVE_ACTION_STATUSES.has(action.status) && !TERMINAL_ACTION_STATUSES.has(action.status))
    .sort((a, b) => b.priority - a.priority || asTime(b.updatedAt ?? b.createdAt) - asTime(a.updatedAt ?? a.createdAt));
}

function setupProgress(input: BusinessOsOwnerDashboardInput) {
  const profile = input.profile;
  if (profile.businessMode === "new_business") {
    const setup = input.setupProfile;
    const completedSteps = countTruthy([
      profile.summary,
      profile.ownerGoals,
      setup?.idea,
      setup?.customerSegments,
      setup?.offers,
      setup?.legalComplianceChecklist,
      setup?.toolStack,
      setup?.rolesAndSops,
    ]);
    const totalSteps = 8;
    return {
      label: "New-business setup progress",
      completedSteps,
      totalSteps,
      percent: Math.round((completedSteps / totalSteps) * 100),
      nextStep: completedSteps >= totalSteps
        ? "Setup baseline is captured; keep improving evidence and operating cadence."
        : "Complete the missing setup sections before increasing autonomy.",
    };
  }

  const audit = input.auditProfile;
  const completedSteps = countTruthy([
    profile.summary,
    profile.ownerGoals,
    audit?.auditScope,
    audit?.evidenceSources,
    input.readiness,
    input.actions,
  ]);
  const totalSteps = 6;
  return {
    label: "Existing-business audit progress",
    completedSteps,
    totalSteps,
    percent: Math.round((completedSteps / totalSteps) * 100),
    nextStep: audit?.auditStatus === "completed"
      ? "Audit baseline is complete; review approvals and weak systems next."
      : "Finish the audit baseline and evidence sources before execution.",
  };
}

export function deriveBusinessOsOwnerDashboard(input: BusinessOsOwnerDashboardInput) {
  const activeActions = sortedActiveActions(input.actions);
  const approvalsRequired = activeActions.filter((action) => action.approvalRequired);
  const atRiskSystems = input.readiness
    .filter((row) => row.readinessScore < 50 || (row.maturityLevel ? WEAK_MATURITY_LEVELS.has(row.maturityLevel) : false))
    .sort((a, b) => a.readinessScore - b.readinessScore)
    .map((row) => row.systemLabel);
  const readinessAverage = input.readiness.length
    ? Math.round(input.readiness.reduce((sum, row) => sum + row.readinessScore, 0) / input.readiness.length)
    : null;
  const maturityCounts = input.readiness.reduce<Record<string, number>>((counts, row) => {
    const key = row.maturityLevel ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  const sinceTime = asTime(input.since);
  const changedSinceLastReview = [
    ...input.agentActivity.map((activity) => ({
      type: "agent_activity" as const,
      label: `Agent activity: ${activity.title}`,
      detail: activity.summary ?? activity.status,
      changedAt: activity.updatedAt ?? null,
    })),
    ...activeActions.map((action) => ({
      type: "action" as const,
      label: `Action updated: ${action.title}`,
      detail: `${action.status.replaceAll("_", " ")} · priority ${action.priority}`,
      changedAt: action.updatedAt ?? action.createdAt ?? null,
    })),
    ...input.recommendations.map((recommendation) => ({
      type: "recommendation" as const,
      label: `Recommendation: ${recommendation.title}`,
      detail: recommendation.expectedOutcome ?? recommendation.rationale,
      changedAt: recommendation.updatedAt ?? recommendation.createdAt ?? null,
    })),
  ]
    .filter((item) => !sinceTime || asTime(item.changedAt) > sinceTime)
    .sort((a, b) => asTime(b.changedAt) - asTime(a.changedAt))
    .slice(0, 8);

  const ownerNextReviewChecklist = [
    approvalsRequired.length > 0
      ? `Review ${approvalsRequired.length} approval-required action${approvalsRequired.length === 1 ? "" : "s"} before ${approvalsRequired.length === 1 ? "it" : "they"} can move into execution.`
      : "No approval-required Business OS actions are waiting right now.",
    atRiskSystems.length > 0
      ? `Check weak systems first: ${atRiskSystems.slice(0, 3).join(", ")}.`
      : "No weak systems are currently below the readiness threshold.",
    input.auditProfile?.knownUnknowns.length
      ? `Resolve known unknowns: ${input.auditProfile.knownUnknowns.slice(0, 2).join("; ")}.`
      : "Known unknowns are clear or not yet recorded.",
  ];

  return {
    headline: `${input.profile.businessName} Business OS — ${input.profile.businessMode === "new_business" ? "setup" : "audit"} command view`,
    summary: input.profile.summary,
    mode: input.profile.businessMode,
    stage: input.profile.stage,
    ownerGoals: input.profile.ownerGoals,
    setupProgress: setupProgress(input),
    auditScorecard: {
      status: input.auditProfile?.auditStatus ?? "not_started",
      score: input.auditProfile?.overallReadinessScore ?? readinessAverage,
      confidence: input.auditProfile?.overallConfidence ?? null,
      scope: input.auditProfile?.auditScope ?? [],
      evidence: (input.auditProfile?.evidenceSources ?? []).map(evidenceLabel),
      knownUnknowns: input.auditProfile?.knownUnknowns ?? [],
    },
    systemMaturity: {
      averageReadinessScore: readinessAverage,
      maturityCounts,
      atRiskSystems,
      systems: input.readiness
        .slice()
        .sort((a, b) => a.readinessScore - b.readinessScore)
        .map((row) => ({
          key: row.systemKey,
          label: row.systemLabel,
          score: row.readinessScore,
          maturity: row.maturityLevel,
          confidence: row.confidence,
          summary: row.summary,
          evidence: row.evidenceRefs.map(evidenceLabel),
        })),
    },
    priorityActions: activeActions.slice(0, 5).map((action) => ({
      title: action.title,
      brief: action.brief,
      status: action.status,
      priority: action.priority,
      riskLevel: action.riskLevel,
      approvalRequired: action.approvalRequired,
      expectedOutcome: action.expectedOutcome,
      measurementMetric: typeof action.measurementPlan.metric === "string" ? action.measurementPlan.metric : null,
      evidence: action.sourceRefs.map(evidenceLabel),
    })),
    approvalsRequired: approvalsRequired.slice(0, 5).map((action) => ({
      title: action.title,
      brief: action.brief,
      status: action.status,
      priority: action.priority,
      riskLevel: action.riskLevel,
      expectedOutcome: action.expectedOutcome,
      evidence: action.sourceRefs.map(evidenceLabel),
    })),
    openGaps: input.gaps
      .filter((gap) => ["open", "accepted", "in_progress"].includes(gap.status))
      .slice(0, 5)
      .map((gap) => ({
        title: gap.title,
        severity: gap.severity,
        status: gap.status,
        systemKey: gap.systemKey ?? null,
        confidence: gap.confidence,
        evidence: gap.evidenceRefs.map(evidenceLabel),
      })),
    agentActivity: input.agentActivity.slice(0, 5).map((activity) => ({
      title: activity.title,
      summary: activity.summary,
      status: activity.status,
      role: activity.role,
      evidenceUrl: activity.evidenceUrl,
      hasEvidence: Boolean(activity.evidenceUrl),
      updatedAt: activity.updatedAt ?? null,
    })),
    changedSinceLastReview,
    governance: {
      approvalPolicy: input.profile.approvalPolicy,
      autonomyPolicy: input.profile.autonomyPolicy,
      aiSpendBudgetLabel: formatBudget(input.profile.aiSpendBudget),
    },
    ownerNextReviewChecklist,
  };
}
