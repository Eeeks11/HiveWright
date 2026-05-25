import {
  pgTable,
  uuid,
  text,
  jsonb,
  varchar,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { goals } from "./goals";
import { goalCompletions } from "./goal-completions";
import { workProducts } from "./work-products";

export const OWNER_OUTCOME_REVIEW_STATES = [
  "new",
  "accepted",
  "needs_revision",
  "archived",
  "converted_to_process_candidate",
] as const;

export type OwnerOutcomeReviewState = typeof OWNER_OUTCOME_REVIEW_STATES[number];

export const ownerOutcomes = pgTable(
  "owner_outcomes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "cascade" }).notNull(),
    goalCompletionId: uuid("goal_completion_id").references(() => goalCompletions.id, { onDelete: "cascade" }).notNull(),
    summary: text("summary").notNull(),
    whyItMatters: text("why_it_matters").default("").notNull(),
    impactStatement: text("impact_statement").default("").notNull(),
    recommendedNextAction: text("recommended_next_action").default("").notNull(),
    evidence: jsonb("evidence").default({}).notNull(),
    primaryWorkProductId: uuid("primary_work_product_id").references(() => workProducts.id, { onDelete: "set null" }),
    primaryOpenUrl: text("primary_open_url"),
    primaryArtifactTitle: text("primary_artifact_title"),
    primaryArtifactRenderMode: varchar("primary_artifact_render_mode", { length: 30 }),
    reviewState: varchar("review_state", { length: 50 }).$type<OwnerOutcomeReviewState>().default("new").notNull(),
    routeMetadata: jsonb("route_metadata").$type<Record<string, unknown>>().default({}).notNull(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    goalCompletionUnique: unique("owner_outcomes_goal_completion_unique").on(t.goalCompletionId),
    hiveReviewCreatedIdx: index("owner_outcomes_hive_review_created_idx").on(t.hiveId, t.reviewState, t.createdAt.desc()),
    goalCreatedIdx: index("owner_outcomes_goal_created_idx").on(t.goalId, t.createdAt.desc()),
  }),
);
