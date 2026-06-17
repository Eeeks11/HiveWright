import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { externalActionRequests } from "./external-action-requests";
import { hives } from "./hives";

export type SalesActionApprovalStatus = "pending_owner_approval" | "approved" | "rejected";
export type SalesActionExecutionStatus = "draft" | "queued" | "executed" | "blocked";
export type SalesWorkflow = "reactivation" | "lead_follow_up" | "review_referral" | "missed_call_recovery" | "sales_training";

export const salesSegments = pgTable(
  "sales_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    source: varchar("source", { length: 64 }).default("manual_import").notNull(),
    customerType: varchar("customer_type", { length: 32 }).default("lead").notNull(),
    filters: jsonb("filters").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("sales_segments_hive_idx").on(table.hiveId),
    check("sales_segments_source_check", sql`${table.source} IN ('manual_import', 'business_records', 'connector')`),
    check("sales_segments_customer_type_check", sql`${table.customerType} IN ('lead', 'customer', 'dormant_customer')`),
    check("sales_segments_filters_object_check", sql`jsonb_typeof(${table.filters}) = 'object'`),
  ],
);

export const salesFunnels = pgTable(
  "sales_funnels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    segmentId: uuid("segment_id").references(() => salesSegments.id, { onDelete: "set null" }),
    goal: text("goal").notNull(),
    stages: jsonb("stages").$type<Record<string, unknown>[]>().default([]).notNull(),
    biggestLeak: jsonb("biggest_leak").$type<Record<string, unknown>>().default({}).notNull(),
    source: varchar("source", { length: 64 }).default("manual_import").notNull(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("sales_funnels_hive_captured_idx").on(table.hiveId, table.capturedAt),
    check("sales_funnels_stages_array_check", sql`jsonb_typeof(${table.stages}) = 'array'`),
    check("sales_funnels_biggest_leak_object_check", sql`jsonb_typeof(${table.biggestLeak}) = 'object'`),
  ],
);

export const salesActionPlans = pgTable(
  "sales_action_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    funnelId: uuid("funnel_id").references(() => salesFunnels.id, { onDelete: "cascade" }).notNull(),
    bottleneck: jsonb("bottleneck").$type<Record<string, unknown>>().default({}).notNull(),
    status: varchar("status", { length: 32 }).default("draft").notNull(),
    boundedBy: text("bounded_by").notNull(),
    approvalPolicy: jsonb("approval_policy").$type<Record<string, unknown>>().default({}).notNull(),
    nextMeasurement: text("next_measurement").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("sales_action_plans_hive_status_idx").on(table.hiveId, table.status),
    check("sales_action_plans_status_check", sql`${table.status} IN ('draft', 'approval', 'running', 'completed')`),
    check("sales_action_plans_bottleneck_object_check", sql`jsonb_typeof(${table.bottleneck}) = 'object'`),
    check("sales_action_plans_approval_policy_object_check", sql`jsonb_typeof(${table.approvalPolicy}) = 'object'`),
  ],
);

export const salesActionDrafts = pgTable(
  "sales_action_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    actionPlanId: uuid("action_plan_id").references(() => salesActionPlans.id, { onDelete: "cascade" }).notNull(),
    externalActionRequestId: uuid("external_action_request_id").references(() => externalActionRequests.id, { onDelete: "set null" }),
    workflow: varchar("workflow", { length: 64 }).$type<SalesWorkflow>().notNull(),
    title: text("title").notNull(),
    draftBody: text("draft_body").notNull(),
    approvalStatus: varchar("approval_status", { length: 32 }).$type<SalesActionApprovalStatus>().default("pending_owner_approval").notNull(),
    executionStatus: varchar("execution_status", { length: 32 }).$type<SalesActionExecutionStatus>().default("draft").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("sales_action_drafts_hive_approval_idx").on(table.hiveId, table.approvalStatus),
    index("sales_action_drafts_action_plan_idx").on(table.actionPlanId),
    index("sales_action_drafts_external_action_request_idx").on(table.externalActionRequestId),
    check("sales_action_drafts_workflow_check", sql`${table.workflow} IN ('reactivation', 'lead_follow_up', 'review_referral', 'missed_call_recovery', 'sales_training')`),
    check("sales_action_drafts_approval_status_check", sql`${table.approvalStatus} IN ('pending_owner_approval', 'approved', 'rejected')`),
    check("sales_action_drafts_execution_status_check", sql`${table.executionStatus} IN ('draft', 'queued', 'executed', 'blocked')`),
  ],
);

export const salesExecutionLogs = pgTable(
  "sales_execution_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    actionPlanId: uuid("action_plan_id").references(() => salesActionPlans.id, { onDelete: "cascade" }).notNull(),
    actionDraftId: uuid("action_draft_id").references(() => salesActionDrafts.id, { onDelete: "set null" }),
    externalActionRequestId: uuid("external_action_request_id").references(() => externalActionRequests.id, { onDelete: "set null" }),
    workflow: varchar("workflow", { length: 64 }).$type<SalesWorkflow>().notNull(),
    connector: varchar("connector", { length: 64 }).default("manual_queue").notNull(),
    trace: jsonb("trace").$type<Record<string, unknown>[]>().default([]).notNull(),
    executedAt: timestamp("executed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("sales_execution_logs_action_plan_executed_idx").on(table.actionPlanId, table.executedAt),
    uniqueIndex("sales_execution_logs_external_action_request_unique")
      .on(table.externalActionRequestId)
      .where(sql`${table.externalActionRequestId} IS NOT NULL`),
    check("sales_execution_logs_trace_array_check", sql`jsonb_typeof(${table.trace}) = 'array'`),
  ],
);
