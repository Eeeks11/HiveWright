import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { externalActionRequests } from "./external-action-requests";
import { connectorInstalls } from "./connectors";
import { growthLoopRuns, growthLoopTemplates } from "./growth-operating-loops";
import { hives } from "./hives";

export type MarketingCampaignStatus = "idea" | "draft" | "approval" | "approved" | "running" | "paused" | "completed" | "killed";
export type MarketingAssetApprovalStatus = "pending_owner_approval" | "approved" | "rejected";
export type MarketingAssetPublicationStatus = "draft" | "queued" | "published" | "blocked";
export type MarketingMetricFreshness = "current" | "stale" | "missing";
export type MarketingAttributionConfidence = "manual_unverified" | "imported" | "connector_verified";

export const marketingProfiles = pgTable(
  "marketing_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    industry: text("industry").notNull(),
    targetCustomers: jsonb("target_customers").$type<string[]>().default([]).notNull(),
    offers: jsonb("offers").$type<string[]>().default([]).notNull(),
    serviceAreas: jsonb("service_areas").$type<string[]>().default([]).notNull(),
    averageCustomerValueCents: integer("average_customer_value_cents"),
    capacityConstraints: jsonb("capacity_constraints").$type<string[]>().default([]).notNull(),
    seasonality: jsonb("seasonality").$type<Record<string, unknown>>().default({}).notNull(),
    brandVoice: text("brand_voice"),
    forbiddenClaims: jsonb("forbidden_claims").$type<string[]>().default([]).notNull(),
    approvalPolicy: jsonb("approval_policy").$type<Record<string, unknown>>().default({}).notNull(),
    connectedChannels: jsonb("connected_channels").$type<Record<string, unknown>[]>().default([]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("marketing_profiles_hive_unique").on(table.hiveId),
    check("marketing_profiles_target_customers_array_check", sql`jsonb_typeof(${table.targetCustomers}) = 'array'`),
    check("marketing_profiles_offers_array_check", sql`jsonb_typeof(${table.offers}) = 'array'`),
    check("marketing_profiles_service_areas_array_check", sql`jsonb_typeof(${table.serviceAreas}) = 'array'`),
    check("marketing_profiles_capacity_constraints_array_check", sql`jsonb_typeof(${table.capacityConstraints}) = 'array'`),
    check("marketing_profiles_seasonality_object_check", sql`jsonb_typeof(${table.seasonality}) = 'object'`),
    check("marketing_profiles_forbidden_claims_array_check", sql`jsonb_typeof(${table.forbiddenClaims}) = 'array'`),
    check("marketing_profiles_approval_policy_object_check", sql`jsonb_typeof(${table.approvalPolicy}) = 'object'`),
    check("marketing_profiles_connected_channels_array_check", sql`jsonb_typeof(${table.connectedChannels}) = 'array'`),
  ],
);

export const marketingCampaigns = pgTable(
  "marketing_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    profileId: uuid("profile_id").references(() => marketingProfiles.id, { onDelete: "set null" }),
    growthLoopTemplateId: uuid("growth_loop_template_id").references(() => growthLoopTemplates.id, { onDelete: "set null" }),
    growthLoopRunId: uuid("growth_loop_run_id").references(() => growthLoopRuns.id, { onDelete: "set null" }),
    objective: text("objective").notNull(),
    status: varchar("status", { length: 32 }).$type<MarketingCampaignStatus>().default("idea").notNull(),
    channels: jsonb("channels").$type<string[]>().default([]).notNull(),
    targetAudience: text("target_audience"),
    offer: text("offer"),
    spendBudgetCents: integer("spend_budget_cents"),
    successMetrics: jsonb("success_metrics").$type<string[]>().default([]).notNull(),
    approvalPolicy: jsonb("approval_policy").$type<Record<string, unknown>>().default({}).notNull(),
    startAt: timestamp("start_at"),
    endAt: timestamp("end_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("marketing_campaigns_hive_status_idx").on(table.hiveId, table.status),
    index("marketing_campaigns_loop_run_idx").on(table.growthLoopRunId),
    check(
      "marketing_campaigns_status_check",
      sql`${table.status} IN ('idea', 'draft', 'approval', 'approved', 'running', 'paused', 'completed', 'killed')`,
    ),
    check("marketing_campaigns_channels_array_check", sql`jsonb_typeof(${table.channels}) = 'array'`),
    check("marketing_campaigns_success_metrics_array_check", sql`jsonb_typeof(${table.successMetrics}) = 'array'`),
    check("marketing_campaigns_approval_policy_object_check", sql`jsonb_typeof(${table.approvalPolicy}) = 'object'`),
  ],
);

export const marketingAssets = pgTable(
  "marketing_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    campaignId: uuid("campaign_id").references(() => marketingCampaigns.id, { onDelete: "cascade" }).notNull(),
    externalActionRequestId: uuid("external_action_request_id").references(() => externalActionRequests.id, {
      onDelete: "set null",
    }),
    assetType: varchar("asset_type", { length: 64 }).notNull(),
    channel: varchar("channel", { length: 64 }).notNull(),
    title: text("title").notNull(),
    draftBody: text("draft_body").notNull(),
    variants: jsonb("variants").$type<Record<string, unknown>[]>().default([]).notNull(),
    approvalStatus: varchar("approval_status", { length: 32 })
      .$type<MarketingAssetApprovalStatus>()
      .default("pending_owner_approval")
      .notNull(),
    publicationStatus: varchar("publication_status", { length: 32 })
      .$type<MarketingAssetPublicationStatus>()
      .default("draft")
      .notNull(),
    scheduledFor: timestamp("scheduled_for"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("marketing_assets_hive_approval_idx").on(table.hiveId, table.approvalStatus),
    index("marketing_assets_campaign_status_idx").on(table.campaignId, table.publicationStatus),
    index("marketing_assets_external_action_request_idx").on(table.externalActionRequestId),
    check(
      "marketing_assets_approval_status_check",
      sql`${table.approvalStatus} IN ('pending_owner_approval', 'approved', 'rejected')`,
    ),
    check("marketing_assets_publication_status_check", sql`${table.publicationStatus} IN ('draft', 'queued', 'published', 'blocked')`),
    check("marketing_assets_variants_array_check", sql`jsonb_typeof(${table.variants}) = 'array'`),
  ],
);

export const marketingMetricSnapshots = pgTable(
  "marketing_metric_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    campaignId: uuid("campaign_id").references(() => marketingCampaigns.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 64 }).default("manual_import").notNull(),
    connectorInstallId: uuid("connector_install_id").references(() => connectorInstalls.id, { onDelete: "set null" }),
    sourceConnector: varchar("source_connector", { length: 128 }),
    sourceStream: varchar("source_stream", { length: 128 }),
    externalId: text("external_id"),
    values: jsonb("values").$type<Record<string, number>>().default({}).notNull(),
    attributionConfidence: varchar("attribution_confidence", { length: 32 })
      .$type<MarketingAttributionConfidence>()
      .default("manual_unverified")
      .notNull(),
    freshness: varchar("freshness", { length: 32 }).$type<MarketingMetricFreshness>().default("current").notNull(),
    trustMetadata: jsonb("trust_metadata").$type<Record<string, unknown>>().default({}).notNull(),
    connectorError: text("connector_error"),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("marketing_metric_snapshots_hive_captured_idx").on(table.hiveId, table.capturedAt),
    index("marketing_metric_snapshots_campaign_captured_idx").on(table.campaignId, table.capturedAt),
    index("marketing_metric_snapshots_connector_idx").on(table.hiveId, table.sourceConnector, table.sourceStream, table.capturedAt),
    uniqueIndex("marketing_metric_snapshots_connector_external_unique")
      .on(table.hiveId, table.connectorInstallId, table.sourceConnector, table.sourceStream, table.externalId)
      .where(sql`${table.connectorInstallId} IS NOT NULL AND ${table.externalId} IS NOT NULL`),
    check("marketing_metric_snapshots_values_object_check", sql`jsonb_typeof(${table.values}) = 'object'`),
    check(
      "marketing_metric_snapshots_attribution_check",
      sql`${table.attributionConfidence} IN ('manual_unverified', 'imported', 'connector_verified')`,
    ),
    check("marketing_metric_snapshots_freshness_check", sql`${table.freshness} IN ('current', 'stale', 'missing')`),
  ],
);

export const marketingExecutionLogs = pgTable(
  "marketing_execution_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    campaignId: uuid("campaign_id").references(() => marketingCampaigns.id, { onDelete: "cascade" }).notNull(),
    assetId: uuid("asset_id").references(() => marketingAssets.id, { onDelete: "set null" }),
    externalActionRequestId: uuid("external_action_request_id").references(() => externalActionRequests.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    connector: varchar("connector", { length: 64 }).default("manual_import").notNull(),
    trace: jsonb("trace").$type<Record<string, unknown>[]>().default([]).notNull(),
    executedAt: timestamp("executed_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("marketing_execution_logs_campaign_executed_idx").on(table.campaignId, table.executedAt),
    uniqueIndex("marketing_execution_logs_external_action_request_unique")
      .on(table.externalActionRequestId)
      .where(sql`${table.externalActionRequestId} IS NOT NULL`),
    check("marketing_execution_logs_trace_array_check", sql`jsonb_typeof(${table.trace}) = 'array'`),
  ],
);
