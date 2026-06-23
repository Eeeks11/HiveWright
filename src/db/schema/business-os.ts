import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export type BusinessMode = "new_business" | "existing_business";

export const businessOsProfiles = pgTable(
  "business_os_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    businessMode: varchar("business_mode", { length: 32 }).$type<BusinessMode>().notNull(),
    businessName: text("business_name").notNull(),
    industry: text("industry"),
    stage: varchar("stage", { length: 64 }),
    summary: text("summary"),
    ownerGoals: jsonb("owner_goals").$type<string[]>().default([]).notNull(),
    constraints: jsonb("constraints").$type<string[]>().default([]).notNull(),
    approvalPolicy: jsonb("approval_policy").$type<Record<string, unknown>>().default({}).notNull(),
    aiSpendBudget: jsonb("ai_spend_budget").$type<Record<string, unknown>>().default({}).notNull(),
    autonomyPolicy: jsonb("autonomy_policy").$type<Record<string, unknown>>().default({}).notNull(),
    sourceProfile: jsonb("source_profile").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("business_os_profiles_hive_unique").on(table.hiveId),
    index("business_os_profiles_mode_idx").on(table.businessMode),
    check("business_os_profiles_mode_check", sql`${table.businessMode} IN ('new_business', 'existing_business')`),
    check("business_os_profiles_owner_goals_array_check", sql`jsonb_typeof(${table.ownerGoals}) = 'array'`),
    check("business_os_profiles_constraints_array_check", sql`jsonb_typeof(${table.constraints}) = 'array'`),
    check("business_os_profiles_approval_policy_object_check", sql`jsonb_typeof(${table.approvalPolicy}) = 'object'`),
    check("business_os_profiles_ai_spend_budget_object_check", sql`jsonb_typeof(${table.aiSpendBudget}) = 'object'`),
    check("business_os_profiles_autonomy_policy_object_check", sql`jsonb_typeof(${table.autonomyPolicy}) = 'object'`),
    check("business_os_profiles_source_profile_object_check", sql`jsonb_typeof(${table.sourceProfile}) = 'object'`),
  ],
);
