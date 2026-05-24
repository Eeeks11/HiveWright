import type { Sql, TransactionSql } from "postgres";
import { OWNER_ACTION_REQUIRED_SQL } from "@/decisions/visibility";
import { getOperatingProfile } from "@/hives/operating-profile";
import { type HiveKind, normalizeHiveKind, normalizeHiveOperatingMode } from "@/hives/kind";

export type ScoreboardSql = Sql | TransactionSql;

export type ScoreboardListItem = {
  id: string;
  title?: string;
  summary?: string;
  status?: string | null;
  priority?: string | null;
  occurredAt?: Date | null;
  createdAt?: Date | null;
  source?: string;
};

export type ScoreboardListSummary = {
  count: number;
  items: ScoreboardListItem[];
};

export type BusinessScoreboardMetrics = {
  kind: "business";
  revenueCents: number;
  expensesCents: number;
  leads: number;
  activeCampaigns: number;
  salesPipeline: number;
  profitLossEstimateCents: number;
};

export type PersonalProjectScoreboardMetrics = {
  kind: "personal_project";
  milestoneProgress: { completed: number; total: number };
  openBlockers: number;
  deliverablesProduced: number;
  deadlineRisk: "none" | "upcoming" | "overdue";
};

export type PersonalAssistantScoreboardMetrics = {
  kind: "personal_assistant";
  openRequests: number;
  overdueReminders: number;
  waitingOnOwnerItems: number;
  sensitiveApprovals: number;
};

export type ResearchScoreboardMetrics = {
  kind: "research";
  questionsAnswered: number;
  sourcesReviewed: number;
  confidence: "unknown" | "low" | "medium" | "high";
  unresolvedUnknowns: number;
};

export type CreativeScoreboardMetrics = {
  kind: "creative";
  draftsAndAssets: number;
  reviewStatus: string;
  publicationState: string;
  feedbackLoop: number;
};

export type HiveScoreboardKindMetrics =
  | BusinessScoreboardMetrics
  | PersonalProjectScoreboardMetrics
  | PersonalAssistantScoreboardMetrics
  | ResearchScoreboardMetrics
  | CreativeScoreboardMetrics;

export type HiveScoreboard = {
  hive: {
    id: string;
    kind: HiveKind;
    name: string;
    currentOutcome: string;
    status: string;
  };
  activeGoals: ScoreboardListSummary;
  blockedItems: ScoreboardListSummary;
  ownerActionsNeeded: ScoreboardListSummary;
  recentCompletions: ScoreboardListSummary;
  nextRecommendedAction: string;
  emptyStateGuidance: string;
  kindMetrics: HiveScoreboardKindMetrics;
};

type GetHiveScoreboardOptions = {
  now?: Date;
};

type HiveRow = {
  id: string;
  name: string;
  kind: string | null;
  operating_mode: string | null;
  description: string | null;
  mission: string | null;
};

type GoalRow = {
  id: string;
  title: string;
  status: string;
  updated_at: Date;
  total_count: number | string;
};

type TaskBlockedRow = {
  id: string;
  title: string;
  status: string;
  updated_at: Date;
  total_count: number | string;
};

type RecordBlockedRow = {
  id: string;
  title: string | null;
  status: string | null;
  occurred_at: Date | null;
  total_count: number | string;
};

type DecisionRow = {
  id: string;
  title: string;
  priority: string;
  created_at: Date;
  total_count: number | string;
};

type CompletionRow = {
  id: string;
  summary: string;
  created_at: Date;
  goal_title: string;
  total_count: number | string;
};

type RecordMetricRow = {
  record_type: string;
  record_family: string | null;
  status: string | null;
  title: string | null;
  amount_cents: number | null;
  occurred_at: Date | null;
  metadata: Record<string, unknown> | null;
};

type WorkProductMetricRow = {
  total: number | string;
  ready: number | string;
  in_review: number | string;
  published: number | string;
};

type TargetMetricRow = {
  open_total: number | string;
  overdue: number | string;
  upcoming: number | string;
};

const ACTIVE_GOAL_STATUSES = ["active", "pending", "in_progress", "open"];
const CLOSED_STATUSES = new Set(["done", "complete", "completed", "resolved", "closed", "cancelled", "canceled", "achieved"]);
const ACTIVE_STATUSES = new Set(["active", "open", "pending", "in_progress", "review", "waiting"]);

export async function getHiveScoreboard(
  sql: ScoreboardSql,
  hiveId: string,
  options: GetHiveScoreboardOptions = {},
): Promise<HiveScoreboard | null> {
  const [hive] = await sql<HiveRow[]>`
    SELECT id, name, kind, operating_mode, description, mission
    FROM hives
    WHERE id = ${hiveId}
    LIMIT 1
  `;
  if (!hive) return null;

  const kind = normalizeHiveKind(hive.kind);
  const status = normalizeHiveOperatingMode(hive.operating_mode);
  const profile = await getOperatingProfile(sql, hive.id);
  const now = options.now ?? new Date();

  const [
    activeGoals,
    taskBlockedRows,
    recordBlockedRows,
    ownerActionRows,
    completionRows,
    recordRows,
    workProductRows,
    targetRows,
  ] = await Promise.all([
    listActiveGoals(sql, hive.id),
    listBlockedTasks(sql, hive.id),
    listBlockedRecords(sql, hive.id),
    listOwnerActionDecisions(sql, hive.id),
    listRecentCompletions(sql, hive.id),
    listMetricRecords(sql, hive.id),
    loadWorkProductMetrics(sql, hive.id),
    loadTargetMetrics(sql, hive.id, now),
  ]);

  const blockedItems = combineBlockedItems(taskBlockedRows, recordBlockedRows);
  const ownerActionsNeeded = rowsToListSummary(ownerActionRows, (row) => ({
    id: row.id,
    title: row.title,
    priority: row.priority,
    createdAt: row.created_at,
    source: "decision",
  }));
  const recentCompletions = rowsToListSummary(completionRows, (row) => ({
    id: row.id,
    title: row.goal_title,
    summary: row.summary,
    createdAt: row.created_at,
    source: "goal_completion",
  }));

  const activeGoalSummary = rowsToListSummary(activeGoals, (row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.updated_at,
    source: "goal",
  }));

  const kindMetrics = buildKindMetrics(kind, {
    records: recordRows,
    workProducts: workProductRows,
    targets: targetRows,
    blockedItems,
    ownerActionsNeeded,
    now,
  });
  const emptyStateGuidance = emptyStateForKind(kind);

  return {
    hive: {
      id: hive.id,
      kind,
      name: hive.name,
      currentOutcome:
        profile?.current30DayOutcome ??
        profile?.desiredOutcome ??
        hive.description ??
        hive.mission ??
        "Define the next outcome for this hive.",
      status,
    },
    activeGoals: activeGoalSummary,
    blockedItems,
    ownerActionsNeeded,
    recentCompletions,
    nextRecommendedAction: recommendNextAction({
      kind,
      activeGoals: activeGoalSummary,
      blockedItems,
      ownerActionsNeeded,
      recentCompletions,
      emptyStateGuidance,
    }),
    emptyStateGuidance,
    kindMetrics,
  };
}

async function listActiveGoals(sql: ScoreboardSql, hiveId: string): Promise<GoalRow[]> {
  return sql<GoalRow[]>`
    SELECT id, title, status, updated_at, COUNT(*) OVER() AS total_count
    FROM goals
    WHERE hive_id = ${hiveId}::uuid
      AND status = ANY(${ACTIVE_GOAL_STATUSES})
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 5
  `;
}

async function listBlockedTasks(sql: ScoreboardSql, hiveId: string): Promise<TaskBlockedRow[]> {
  return sql<TaskBlockedRow[]>`
    SELECT id, title, status, updated_at, COUNT(*) OVER() AS total_count
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND status = 'blocked'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 5
  `;
}

async function listBlockedRecords(sql: ScoreboardSql, hiveId: string): Promise<RecordBlockedRow[]> {
  return sql<RecordBlockedRow[]>`
    SELECT id, title, status, occurred_at, COUNT(*) OVER() AS total_count
    FROM business_records
    WHERE hive_id = ${hiveId}::uuid
      AND (
        record_type IN ('blocker', 'risk', 'unknown', 'uncertainty')
        OR lower(COALESCE(status, '')) = 'blocked'
      )
      AND lower(COALESCE(status, 'open')) NOT IN ('done', 'complete', 'completed', 'resolved', 'closed', 'cancelled', 'canceled', 'achieved')
    ORDER BY occurred_at DESC NULLS LAST, created_at DESC
    LIMIT 5
  `;
}

async function listOwnerActionDecisions(sql: ScoreboardSql, hiveId: string): Promise<DecisionRow[]> {
  return sql<DecisionRow[]>`
    SELECT d.id, d.title, d.priority, d.created_at, COUNT(*) OVER() AS total_count
    FROM decisions d
    JOIN hives h ON h.id = d.hive_id
    LEFT JOIN tasks t ON t.id = d.task_id AND t.hive_id = d.hive_id
    WHERE d.hive_id = ${hiveId}::uuid
      AND d.status = 'pending'
      AND ${sql.unsafe(OWNER_ACTION_REQUIRED_SQL)}
    ORDER BY
      CASE d.priority
        WHEN 'urgent' THEN 1
        WHEN 'high' THEN 2
        WHEN 'normal' THEN 3
        WHEN 'low' THEN 4
        ELSE 5
      END,
      d.created_at DESC
    LIMIT 5
  `;
}

async function listRecentCompletions(sql: ScoreboardSql, hiveId: string): Promise<CompletionRow[]> {
  return sql<CompletionRow[]>`
    SELECT gc.id, gc.summary, gc.created_at, g.title AS goal_title, COUNT(*) OVER() AS total_count
    FROM goal_completions gc
    JOIN goals g ON g.id = gc.goal_id
    WHERE g.hive_id = ${hiveId}::uuid
    ORDER BY gc.created_at DESC
    LIMIT 5
  `;
}

async function listMetricRecords(sql: ScoreboardSql, hiveId: string): Promise<RecordMetricRow[]> {
  return sql<RecordMetricRow[]>`
    SELECT record_type, record_family, status, title, amount_cents, occurred_at, metadata
    FROM business_records
    WHERE hive_id = ${hiveId}::uuid
    ORDER BY occurred_at DESC NULLS LAST, created_at DESC
    LIMIT 1000
  `;
}

async function loadWorkProductMetrics(sql: ScoreboardSql, hiveId: string): Promise<WorkProductMetricRow> {
  const [row] = await sql<WorkProductMetricRow[]>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE review_status = 'ready')::int AS ready,
      COUNT(*) FILTER (WHERE review_status IN ('review', 'needs_review', 'needs_revision'))::int AS in_review,
      COUNT(*) FILTER (WHERE published_at IS NOT NULL)::int AS published
    FROM work_products
    WHERE hive_id = ${hiveId}::uuid
  `;
  return row ?? { total: 0, ready: 0, in_review: 0, published: 0 };
}

async function loadTargetMetrics(sql: ScoreboardSql, hiveId: string, now: Date): Promise<TargetMetricRow> {
  const [row] = await sql<TargetMetricRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE status = 'open')::int AS open_total,
      COUNT(*) FILTER (WHERE status = 'open' AND deadline IS NOT NULL AND deadline < ${now})::int AS overdue,
      COUNT(*) FILTER (
        WHERE status = 'open'
          AND deadline IS NOT NULL
          AND deadline >= ${now}
          AND deadline <= ${new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)}
      )::int AS upcoming
    FROM hive_targets
    WHERE hive_id = ${hiveId}::uuid
  `;
  return row ?? { open_total: 0, overdue: 0, upcoming: 0 };
}

function rowsToListSummary<T extends { total_count: number | string }>(
  rows: T[],
  map: (row: T) => ScoreboardListItem,
): ScoreboardListSummary {
  return {
    count: rows.length > 0 ? Number(rows[0].total_count) : 0,
    items: rows.map(map),
  };
}

function combineBlockedItems(taskRows: TaskBlockedRow[], recordRows: RecordBlockedRow[]): ScoreboardListSummary {
  const taskCount = taskRows.length > 0 ? Number(taskRows[0].total_count) : 0;
  const recordCount = recordRows.length > 0 ? Number(recordRows[0].total_count) : 0;
  const recordItems = recordRows.map((row) => ({
    id: row.id,
    title: row.title ?? "Blocked record",
    status: row.status,
    occurredAt: row.occurred_at,
    source: "record",
  }));
  const taskItems = taskRows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.updated_at,
    source: "task",
  }));

  return {
    count: taskCount + recordCount,
    items: [...taskItems, ...recordItems].slice(0, 5),
  };
}

function buildKindMetrics(
  kind: HiveKind,
  input: {
    records: RecordMetricRow[];
    workProducts: WorkProductMetricRow;
    targets: TargetMetricRow;
    blockedItems: ScoreboardListSummary;
    ownerActionsNeeded: ScoreboardListSummary;
    now: Date;
  },
): HiveScoreboardKindMetrics {
  switch (kind) {
    case "business":
      return businessMetrics(input.records);
    case "personal_project":
      return projectMetrics(input.records, input.workProducts, input.targets, input.blockedItems);
    case "personal_assistant":
      return assistantMetrics(input.records, input.ownerActionsNeeded, input.now);
    case "research":
      return researchMetrics(input.records);
    case "creative":
      return creativeMetrics(input.records, input.workProducts);
  }
}

function businessMetrics(records: RecordMetricRow[]): BusinessScoreboardMetrics {
  const revenueCents = sumAmounts(records, (record) => ["sale", "revenue", "invoice_payment"].includes(record.record_type));
  const expensesCents = sumAmounts(records, (record) => record.record_type === "expense");
  const leads = records.filter((record) => ["lead", "customer_event"].includes(record.record_type)).length;
  const activeCampaigns = records.filter((record) =>
    ["campaign", "campaign_update", "operations_update"].includes(record.record_type) &&
    isActiveStatus(record.status),
  ).length;
  const salesPipeline = records.filter((record) =>
    ["lead", "opportunity", "customer_event"].includes(record.record_type) &&
    !isClosedStatus(record.status),
  ).length;

  return {
    kind: "business",
    revenueCents,
    expensesCents,
    leads,
    activeCampaigns,
    salesPipeline,
    profitLossEstimateCents: revenueCents - expensesCents,
  };
}

function projectMetrics(
  records: RecordMetricRow[],
  workProducts: WorkProductMetricRow,
  targets: TargetMetricRow,
  blockedItems: ScoreboardListSummary,
): PersonalProjectScoreboardMetrics {
  const milestones = records.filter((record) => record.record_type === "milestone");
  const completedMilestones = milestones.filter((record) => isClosedStatus(record.status)).length;
  return {
    kind: "personal_project",
    milestoneProgress: { completed: completedMilestones, total: milestones.length },
    openBlockers: blockedItems.count,
    deliverablesProduced: Number(workProducts.total),
    deadlineRisk: deadlineRisk(targets),
  };
}

function assistantMetrics(
  records: RecordMetricRow[],
  ownerActionsNeeded: ScoreboardListSummary,
  now: Date,
): PersonalAssistantScoreboardMetrics {
  return {
    kind: "personal_assistant",
    openRequests: records.filter((record) =>
      ["task", "request", "errand", "appointment", "reminder"].includes(record.record_type) &&
      !isClosedStatus(record.status),
    ).length,
    overdueReminders: records.filter((record) =>
      record.record_type === "reminder" &&
      !isClosedStatus(record.status) &&
      record.occurred_at !== null &&
      record.occurred_at.getTime() < now.getTime(),
    ).length,
    waitingOnOwnerItems: ownerActionsNeeded.count,
    sensitiveApprovals: ownerActionsNeeded.items.filter((item) =>
      `${item.title ?? ""} ${item.summary ?? ""}`.toLowerCase().match(/sensitive|approval|approve|book|spend|send|share/),
    ).length,
  };
}

function researchMetrics(records: RecordMetricRow[]): ResearchScoreboardMetrics {
  const confidence = confidenceFromRecords(records);
  return {
    kind: "research",
    questionsAnswered: records.filter((record) =>
      ["finding", "recommendation"].includes(record.record_type) ||
      (record.record_type === "question" && isClosedStatus(record.status)),
    ).length,
    sourcesReviewed: records.filter((record) => record.record_type === "source").length,
    confidence,
    unresolvedUnknowns: records.filter((record) =>
      ["question", "uncertainty", "unknown"].includes(record.record_type) &&
      !isClosedStatus(record.status),
    ).length,
  };
}

function creativeMetrics(records: RecordMetricRow[], workProducts: WorkProductMetricRow): CreativeScoreboardMetrics {
  const draftAndAssetRecords = records.filter((record) => ["draft", "asset", "variant"].includes(record.record_type)).length;
  const reviewRecords = records.filter((record) => record.record_type === "review");
  const publications = records.filter((record) => record.record_type === "publication").length + Number(workProducts.published);
  return {
    kind: "creative",
    draftsAndAssets: draftAndAssetRecords + Number(workProducts.total),
    reviewStatus: Number(workProducts.in_review) > 0 || reviewRecords.some((record) => !isClosedStatus(record.status))
      ? "review needed"
      : "ready",
    publicationState: publications > 0 ? "published" : "not published",
    feedbackLoop: reviewRecords.length + records.filter((record) => record.record_family === "feedback").length,
  };
}

function sumAmounts(records: RecordMetricRow[], predicate: (record: RecordMetricRow) => boolean): number {
  return records
    .filter(predicate)
    .reduce((total, record) => total + Math.abs(record.amount_cents ?? 0), 0);
}

function isClosedStatus(status: string | null): boolean {
  return CLOSED_STATUSES.has((status ?? "").toLowerCase());
}

function isActiveStatus(status: string | null): boolean {
  const normalized = (status ?? "active").toLowerCase();
  return ACTIVE_STATUSES.has(normalized) || !isClosedStatus(normalized);
}

function deadlineRisk(targets: TargetMetricRow): "none" | "upcoming" | "overdue" {
  if (Number(targets.overdue) > 0) return "overdue";
  if (Number(targets.upcoming) > 0) return "upcoming";
  return "none";
}

function confidenceFromRecords(records: RecordMetricRow[]): "unknown" | "low" | "medium" | "high" {
  const values = records
    .map((record) => record.metadata?.confidence)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  if (values.includes("low")) return "low";
  return "unknown";
}

function emptyStateForKind(kind: HiveKind): string {
  switch (kind) {
    case "business":
      return "Add business records or goals so this hive can show revenue, costs, pipeline, and the next commercial action.";
    case "personal_project":
      return "Add project records or goals so this hive can show milestones, blockers, deliverables, and deadline risk.";
    case "personal_assistant":
      return "Add assistant records or goals so this hive can track requests, reminders, owner approvals, and prepared actions.";
    case "research":
      return "Add research records or goals so this hive has questions, sources, findings, confidence, and unknowns to work from.";
    case "creative":
      return "Add creative records or goals so this hive can track drafts, assets, reviews, publication, and feedback.";
  }
}

function recommendNextAction(input: {
  kind: HiveKind;
  activeGoals: ScoreboardListSummary;
  blockedItems: ScoreboardListSummary;
  ownerActionsNeeded: ScoreboardListSummary;
  recentCompletions: ScoreboardListSummary;
  emptyStateGuidance: string;
}): string {
  const ownerAction = input.ownerActionsNeeded.items[0];
  if (ownerAction?.title) return `Resolve owner action: ${ownerAction.title}.`;

  const blocked = input.blockedItems.items[0];
  if (blocked?.title) return `Unblock: ${blocked.title}.`;

  const activeGoal = input.activeGoals.items[0];
  if (activeGoal?.title) return `Continue active goal: ${activeGoal.title}.`;

  const completion = input.recentCompletions.items[0];
  if (completion?.summary) return `Review the latest completion and decide the next outcome: ${completion.summary}`;

  return input.emptyStateGuidance;
}
