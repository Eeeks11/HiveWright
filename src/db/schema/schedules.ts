import { pgTable, uuid, varchar, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { tasks } from "./tasks";
import type { ScheduleRevisionSnapshotV1 } from "@/schedules/revision-snapshot";

export const schedules = pgTable("schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  cronExpression: varchar("cron_expression", { length: 100 }).notNull(),
  taskTemplate: jsonb("task_template").$type<{
    kind?: string;
    goalId?: string | null;
    assignedTo: string;
    title: string;
    brief: string;
    qaRequired?: boolean;
    priority?: number;
  }>().notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  originType: varchar("origin_type", { length: 32 }).default("custom").notNull(),
  originKey: varchar("origin_key", { length: 128 }),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  createdBy: varchar("created_by", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const scheduleFireSnapshots = pgTable("schedule_fire_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "cascade" }).notNull(),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  snapshotHash: varchar("snapshot_hash", { length: 71 }).notNull(),
  snapshot: jsonb("snapshot").$type<ScheduleRevisionSnapshotV1>().notNull(),
  firedAt: timestamp("fired_at").defaultNow().notNull(),
}, (table) => [
  index("schedule_fire_snapshots_schedule_id_idx").on(table.scheduleId),
  index("schedule_fire_snapshots_task_id_idx").on(table.taskId),
  index("schedule_fire_snapshots_snapshot_hash_idx").on(table.snapshotHash),
]);
