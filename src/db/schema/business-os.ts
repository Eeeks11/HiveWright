import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { decisions } from "./decisions";
import { externalActionRequests } from "./external-action-requests";
import { hives } from "./hives";
import { roleTemplates } from "./role-templates";

export type BusinessMode = "new_business" | "existing_business";
export type BusinessSetupSourceKind = "setup" | "audit" | "manual_update" | "loop_measurement";

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

export const businessSetupProfiles = pgTable(
  "business_setup_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    businessOsProfileId: uuid("business_os_profile_id").references(() => businessOsProfiles.id, { onDelete: "cascade" }).notNull(),
    idea: text("idea").notNull(),
    customerSegments: jsonb("customer_segments").$type<string[]>().default([]).notNull(),
    problemStatements: jsonb("problem_statements").$type<string[]>().default([]).notNull(),
    offers: jsonb("offers").$type<string[]>().default([]).notNull(),
    pricingModel: jsonb("pricing_model").$type<Record<string, unknown>>().default({}).notNull(),
    brandPositioning: jsonb("brand_positioning").$type<Record<string, unknown>>().default({}).notNull(),
    salesModel: jsonb("sales_model").$type<Record<string, unknown>>().default({}).notNull(),
    marketingModel: jsonb("marketing_model").$type<Record<string, unknown>>().default({}).notNull(),
    deliveryModel: jsonb("delivery_model").$type<Record<string, unknown>>().default({}).notNull(),
    adminFinanceModel: jsonb("admin_finance_model").$type<Record<string, unknown>>().default({}).notNull(),
    legalComplianceChecklist: jsonb("legal_compliance_checklist").$type<string[]>().default([]).notNull(),
    toolStack: jsonb("tool_stack").$type<string[]>().default([]).notNull(),
    rolesAndSops: jsonb("roles_and_sops").$type<string[]>().default([]).notNull(),
    launchPlanId: uuid("launch_plan_id"),
    readinessSnapshotId: uuid("readiness_snapshot_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("business_setup_profiles_hive_unique").on(table.hiveId),
    index("business_setup_profiles_profile_idx").on(table.businessOsProfileId),
    check("business_setup_profiles_customer_segments_array_check", sql`jsonb_typeof(${table.customerSegments}) = 'array'`),
    check("business_setup_profiles_problem_statements_array_check", sql`jsonb_typeof(${table.problemStatements}) = 'array'`),
    check("business_setup_profiles_offers_array_check", sql`jsonb_typeof(${table.offers}) = 'array'`),
    check("business_setup_profiles_pricing_model_object_check", sql`jsonb_typeof(${table.pricingModel}) = 'object'`),
    check("business_setup_profiles_brand_positioning_object_check", sql`jsonb_typeof(${table.brandPositioning}) = 'object'`),
    check("business_setup_profiles_sales_model_object_check", sql`jsonb_typeof(${table.salesModel}) = 'object'`),
    check("business_setup_profiles_marketing_model_object_check", sql`jsonb_typeof(${table.marketingModel}) = 'object'`),
    check("business_setup_profiles_delivery_model_object_check", sql`jsonb_typeof(${table.deliveryModel}) = 'object'`),
    check("business_setup_profiles_admin_finance_model_object_check", sql`jsonb_typeof(${table.adminFinanceModel}) = 'object'`),
    check("business_setup_profiles_legal_checklist_array_check", sql`jsonb_typeof(${table.legalComplianceChecklist}) = 'array'`),
    check("business_setup_profiles_tool_stack_array_check", sql`jsonb_typeof(${table.toolStack}) = 'array'`),
    check("business_setup_profiles_roles_sops_array_check", sql`jsonb_typeof(${table.rolesAndSops}) = 'array'`),
  ],
);

export const businessSystemReadiness = pgTable(
  "business_system_readiness",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    businessOsProfileId: uuid("business_os_profile_id").references(() => businessOsProfiles.id, { onDelete: "cascade" }).notNull(),
    sourceKind: varchar("source_kind", { length: 32 }).$type<BusinessSetupSourceKind>().notNull(),
    sourceId: uuid("source_id"),
    systemKey: varchar("system_key", { length: 64 }).notNull(),
    systemLabel: text("system_label").notNull(),
    readinessScore: integer("readiness_score").notNull(),
    maturityLevel: varchar("maturity_level", { length: 32 }),
    confidence: varchar("confidence", { length: 32 }),
    evidenceRefs: jsonb("evidence_refs").$type<Array<Record<string, unknown>>>().default([]).notNull(),
    summary: text("summary"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("business_system_readiness_hive_system_idx").on(table.hiveId, table.systemKey),
    index("business_system_readiness_profile_idx").on(table.businessOsProfileId),
    check("business_system_readiness_source_kind_check", sql`${table.sourceKind} IN ('setup', 'audit', 'manual_update', 'loop_measurement')`),
    check("business_system_readiness_score_check", sql`${table.readinessScore} >= 0 AND ${table.readinessScore} <= 100`),
    check("business_system_readiness_maturity_check", sql`${table.maturityLevel} IS NULL OR ${table.maturityLevel} IN ('missing', 'ad_hoc', 'defined', 'managed', 'optimising')`),
    check("business_system_readiness_confidence_check", sql`${table.confidence} IS NULL OR ${table.confidence} IN ('low', 'medium', 'high')`),
    check("business_system_readiness_evidence_array_check", sql`jsonb_typeof(${table.evidenceRefs}) = 'array'`),
  ],
);

export const businessGaps = pgTable(
  "business_gaps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    businessOsProfileId: uuid("business_os_profile_id").references(() => businessOsProfiles.id, { onDelete: "cascade" }).notNull(),
    systemReadinessId: uuid("system_readiness_id").references(() => businessSystemReadiness.id, { onDelete: "set null" }),
    gapType: varchar("gap_type", { length: 64 }),
    severity: varchar("severity", { length: 32 }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<Array<Record<string, unknown>>>().default([]).notNull(),
    confidence: varchar("confidence", { length: 32 }),
    status: varchar("status", { length: 32 }).default("open").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("business_gaps_hive_status_idx").on(table.hiveId, table.status),
    index("business_gaps_profile_idx").on(table.businessOsProfileId),
    check("business_gaps_severity_check", sql`${table.severity} IS NULL OR ${table.severity} IN ('low', 'medium', 'high', 'critical')`),
    check("business_gaps_status_check", sql`${table.status} IN ('open', 'accepted', 'in_progress', 'resolved', 'deferred', 'rejected')`),
    check("business_gaps_evidence_array_check", sql`jsonb_typeof(${table.evidenceRefs}) = 'array'`),
  ],
);

export const businessRecommendations = pgTable(
  "business_recommendations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    gapId: uuid("gap_id").references(() => businessGaps.id, { onDelete: "cascade" }),
    recommendationType: varchar("recommendation_type", { length: 64 }),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    expectedOutcome: text("expected_outcome"),
    estimatedEffort: varchar("estimated_effort", { length: 32 }),
    riskLevel: varchar("risk_level", { length: 32 }),
    requiresOwnerApproval: boolean("requires_owner_approval").default(true).notNull(),
    status: varchar("status", { length: 32 }).default("proposed").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("business_recommendations_hive_status_idx").on(table.hiveId, table.status),
    index("business_recommendations_gap_idx").on(table.gapId),
    check("business_recommendations_risk_check", sql`${table.riskLevel} IS NULL OR ${table.riskLevel} IN ('low', 'medium', 'high')`),
    check("business_recommendations_status_check", sql`${table.status} IN ('proposed', 'accepted', 'rejected', 'converted_to_action', 'superseded')`),
  ],
);

export const businessActions = pgTable(
  "business_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    businessOsProfileId: uuid("business_os_profile_id").references(() => businessOsProfiles.id, { onDelete: "cascade" }).notNull(),
    recommendationId: uuid("recommendation_id").references(() => businessRecommendations.id, { onDelete: "set null" }),
    systemKey: varchar("system_key", { length: 64 }),
    actionType: varchar("action_type", { length: 64 }),
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    status: varchar("status", { length: 32 }).default("draft").notNull(),
    priority: integer("priority").default(50).notNull(),
    riskLevel: varchar("risk_level", { length: 32 }),
    approvalRequired: boolean("approval_required").default(true).notNull(),
    externalActionRequestId: uuid("external_action_request_id").references(() => externalActionRequests.id, { onDelete: "set null" }),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    assignedRoleSlug: varchar("assigned_role_slug", { length: 128 }).references(() => roleTemplates.slug, { onDelete: "set null" }),
    sourceRefs: jsonb("source_refs").$type<Array<Record<string, unknown>>>().default([]).notNull(),
    expectedOutcome: text("expected_outcome"),
    measurementPlan: jsonb("measurement_plan").$type<Record<string, unknown>>().default({}).notNull(),
    dueAt: timestamp("due_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("business_actions_hive_status_priority_idx").on(table.hiveId, table.status, table.priority),
    index("business_actions_profile_idx").on(table.businessOsProfileId),
    index("business_actions_recommendation_idx").on(table.recommendationId),
    check("business_actions_status_check", sql`${table.status} IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked', 'completed', 'failed', 'cancelled')`),
    check("business_actions_risk_check", sql`${table.riskLevel} IS NULL OR ${table.riskLevel} IN ('low', 'medium', 'high')`),
    check("business_actions_source_refs_array_check", sql`jsonb_typeof(${table.sourceRefs}) = 'array'`),
    check("business_actions_measurement_plan_object_check", sql`jsonb_typeof(${table.measurementPlan}) = 'object'`),
  ],
);
