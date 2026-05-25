import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const hiveOperatingProfiles = pgTable("hive_operating_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
  kind: varchar("kind", { length: 50 }).notNull(),
  purpose: text("purpose").notNull(),
  desiredOutcome: text("desired_outcome").notNull(),
  current30DayOutcome: text("current_30_day_outcome"),
  constraints: jsonb("constraints").default([]).notNull(),
  approvalRules: jsonb("approval_rules").default([]).notNull(),
  forbiddenActions: jsonb("forbidden_actions").default([]).notNull(),
  importantContext: jsonb("important_context").default([]).notNull(),
  successCriteria: jsonb("success_criteria").default([]).notNull(),
  stopOrPauseCriteria: jsonb("stop_or_pause_criteria").default([]).notNull(),
  kindProfile: jsonb("kind_profile").default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("hive_operating_profiles_hive_id_unique").on(table.hiveId),
  index("hive_operating_profiles_kind_idx").on(table.kind),
  check(
    "hive_operating_profiles_kind_check",
    sql`${table.kind} IN ('business', 'personal_project', 'personal_assistant', 'research', 'creative')`,
  ),
]);
