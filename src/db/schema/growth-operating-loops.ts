import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { businessRecords } from "./business-records";
import { externalActionRequests } from "./external-action-requests";
import { hives } from "./hives";

export type GrowthLoopDomain = "marketing-attention" | "sales-conversion";
export type GrowthLoopStage = "observe" | "plan" | "execute" | "measure" | "optimise";
export type GrowthLoopRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
export type GrowthLoopOwnerVisibleOutputPolicy = "exception-only" | "approval-request" | "weekly-summary";
export type GrowthLoopOptimiserDecision = "kill" | "keep" | "change" | "scale" | "observe_more";

export const growthLoopTemplates = pgTable(
  "growth_loop_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 32 }).$type<GrowthLoopDomain>().notNull(),
    slug: varchar("slug", { length: 128 }).notNull(),
    name: text("name").notNull(),
    objective: text("objective").notNull(),
    stages: jsonb("stages").$type<Record<string, unknown>[]>().notNull(),
    successMetric: text("success_metric").notNull(),
    ownerVisibleOutputPolicy: varchar("owner_visible_output_policy", { length: 32 })
      .$type<GrowthLoopOwnerVisibleOutputPolicy>()
      .notNull(),
    defaultAutonomyLevel: integer("default_autonomy_level").default(1).notNull(),
    approvalPolicy: jsonb("approval_policy").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("growth_loop_templates_hive_slug_unique").on(table.hiveId, table.slug).nullsNotDistinct(),
    index("growth_loop_templates_hive_domain_idx").on(table.hiveId, table.domain),
    check("growth_loop_templates_domain_check", sql`${table.domain} IN ('marketing-attention', 'sales-conversion')`),
    check("growth_loop_templates_stages_array_check", sql`jsonb_typeof(${table.stages}) = 'array'`),
    check(
      "growth_loop_templates_owner_output_policy_check",
      sql`${table.ownerVisibleOutputPolicy} IN ('exception-only', 'approval-request', 'weekly-summary')`,
    ),
    check(
      "growth_loop_templates_autonomy_level_check",
      sql`${table.defaultAutonomyLevel} >= 0 AND ${table.defaultAutonomyLevel} <= 5`,
    ),
    check("growth_loop_templates_approval_policy_object_check", sql`jsonb_typeof(${table.approvalPolicy}) = 'object'`),
  ],
);

export const growthLoopRuns = pgTable(
  "growth_loop_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    templateId: uuid("template_id").references(() => growthLoopTemplates.id, { onDelete: "set null" }),
    domain: varchar("domain", { length: 32 }).$type<GrowthLoopDomain>().notNull(),
    stage: varchar("stage", { length: 32 }).$type<GrowthLoopStage>().notNull(),
    status: varchar("status", { length: 32 }).$type<GrowthLoopRunStatus>().default("queued").notNull(),
    cycleKey: varchar("cycle_key", { length: 128 }).notNull(),
    inputsManifest: jsonb("inputs_manifest").$type<Record<string, unknown>[]>().default([]).notNull(),
    outputsManifest: jsonb("outputs_manifest").$type<Record<string, unknown>[]>().default([]).notNull(),
    stageState: jsonb("stage_state").$type<Record<string, unknown>[]>().default([]).notNull(),
    nextStage: varchar("next_stage", { length: 32 }).$type<GrowthLoopStage>(),
    approvalsRequired: jsonb("approvals_required").$type<Record<string, unknown>[]>().default([]).notNull(),
    externalActionRequestId: uuid("external_action_request_id").references(() => externalActionRequests.id, {
      onDelete: "set null",
    }),
    metricsSnapshotRecordId: uuid("metrics_snapshot_record_id").references(() => businessRecords.id, { onDelete: "set null" }),
    optimiserDecision: varchar("optimiser_decision", { length: 32 }).$type<GrowthLoopOptimiserDecision>(),
    ownerVisibleOutput: jsonb("owner_visible_output").$type<Record<string, unknown>>().default({}).notNull(),
    state: jsonb("state").$type<Record<string, unknown>>().default({}).notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("growth_loop_runs_hive_domain_status_idx").on(table.hiveId, table.domain, table.status),
    index("growth_loop_runs_hive_cycle_idx").on(table.hiveId, table.cycleKey),
    index("growth_loop_runs_template_created_idx").on(table.templateId, table.createdAt),
    index("growth_loop_runs_external_action_request_idx").on(table.externalActionRequestId),
    check("growth_loop_runs_domain_check", sql`${table.domain} IN ('marketing-attention', 'sales-conversion')`),
    check("growth_loop_runs_stage_check", sql`${table.stage} IN ('observe', 'plan', 'execute', 'measure', 'optimise')`),
    check(
      "growth_loop_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "growth_loop_runs_next_stage_check",
      sql`${table.nextStage} IS NULL OR ${table.nextStage} IN ('observe', 'plan', 'execute', 'measure', 'optimise')`,
    ),
    check("growth_loop_runs_inputs_array_check", sql`jsonb_typeof(${table.inputsManifest}) = 'array'`),
    check("growth_loop_runs_outputs_array_check", sql`jsonb_typeof(${table.outputsManifest}) = 'array'`),
    check("growth_loop_runs_stage_state_array_check", sql`jsonb_typeof(${table.stageState}) = 'array'`),
    check("growth_loop_runs_approvals_array_check", sql`jsonb_typeof(${table.approvalsRequired}) = 'array'`),
    check("growth_loop_runs_owner_output_object_check", sql`jsonb_typeof(${table.ownerVisibleOutput}) = 'object'`),
    check("growth_loop_runs_state_object_check", sql`jsonb_typeof(${table.state}) = 'object'`),
    check(
      "growth_loop_runs_optimiser_decision_check",
      sql`${table.optimiserDecision} IS NULL OR ${table.optimiserDecision} IN ('kill', 'keep', 'change', 'scale', 'observe_more')`,
    ),
  ],
);
