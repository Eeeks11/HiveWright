import { bigserial, integer, jsonb, pgTable, text, timestamp, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { tasks } from "./tasks";
import { goals } from "./goals";
import type { UsageDetails } from "@/usage/billable-usage";

export const executionRuns = pgTable("execution_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
  adapterType: varchar("adapter_type", { length: 100 }).notNull(),
  model: varchar("model", { length: 255 }),
  sessionId: text("session_id"),
  dispatcherPid: integer("dispatcher_pid"),
  processGroupId: integer("process_group_id"),
  hostId: varchar("host_id", { length: 255 }),
  status: varchar("status", { length: 50 }).default("pending").notNull(),
  livenessState: varchar("liveness_state", { length: 50 }).default("pending").notNull(),
  livenessReason: text("liveness_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  lastOutputAt: timestamp("last_output_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }).defaultNow().notNull(),
  exitCode: integer("exit_code"),
  signal: varchar("signal", { length: 50 }),
  stdoutExcerpt: text("stdout_excerpt"),
  stderrExcerpt: text("stderr_excerpt"),
  outputBytes: integer("output_bytes").default(0).notNull(),
  logRef: text("log_ref"),
  logHash: varchar("log_hash", { length: 128 }),
  logBytes: integer("log_bytes"),
  freshInputTokens: integer("fresh_input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  tokensInput: integer("tokens_input"),
  tokensOutput: integer("tokens_output"),
  estimatedBillableCostCents: integer("estimated_billable_cost_cents"),
  usageDetails: jsonb("usage_details").$type<UsageDetails>(),
  retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => executionRuns.id, { onDelete: "set null" }),
  continuationAttempt: integer("continuation_attempt").default(0).notNull(),
  finalizationResult: varchar("finalization_result", { length: 100 }),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const executionRunEvents = pgTable("execution_run_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: uuid("run_id").references(() => executionRuns.id, { onDelete: "cascade" }).notNull(),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  message: text("message"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
