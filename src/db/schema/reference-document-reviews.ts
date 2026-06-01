import { foreignKey, numeric, pgTable, text, timestamp, uniqueIndex, uuid, varchar, index } from "drizzle-orm/pg-core";
import { businessRecords } from "./business-records";
import { hives } from "./hives";
import { hiveReferenceDocuments } from "./hive-reference-documents";

export const hiveReferenceDocumentReviewJobs = pgTable("hive_reference_document_review_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").notNull().references(() => hives.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => hiveReferenceDocuments.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 64 }).default("pending").notNull(),
  error: text("error"),
  reviewedBy: uuid("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("hive_reference_document_review_jobs_hive_document_idx").on(table.hiveId, table.documentId),
  uniqueIndex("hive_reference_document_review_jobs_tuple_idx").on(table.id, table.hiveId, table.documentId),
  index("hive_reference_document_review_jobs_hive_status_idx").on(table.hiveId, table.status, table.createdAt),
]);

export const hiveReferenceDocumentRecordProposals = pgTable("hive_reference_document_record_proposals", {
  id: uuid("id").defaultRandom().primaryKey(),
  reviewJobId: uuid("review_job_id").notNull().references(() => hiveReferenceDocumentReviewJobs.id, { onDelete: "cascade" }),
  hiveId: uuid("hive_id").notNull().references(() => hives.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => hiveReferenceDocuments.id, { onDelete: "cascade" }),
  proposedCategory: varchar("proposed_category", { length: 128 }).notNull(),
  proposedRecordType: varchar("proposed_record_type", { length: 128 }).default("document_context").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  sourceExcerpt: text("source_excerpt"),
  sourcePage: text("source_page"),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  suggestedStatus: varchar("suggested_status", { length: 64 }).default("needs_confirmation").notNull(),
  decision: varchar("decision", { length: 64 }).default("pending").notNull(),
  decisionNotes: text("decision_notes"),
  acceptedRecordId: uuid("accepted_record_id").references(() => businessRecords.id, { onDelete: "set null" }),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("hive_reference_document_record_proposals_job_idx").on(table.reviewJobId, table.createdAt),
  index("hive_reference_document_record_proposals_hive_decision_idx").on(table.hiveId, table.decision, table.createdAt),
  foreignKey({
    name: "hive_reference_document_record_proposals_job_tuple_fk",
    columns: [table.reviewJobId, table.hiveId, table.documentId],
    foreignColumns: [hiveReferenceDocumentReviewJobs.id, hiveReferenceDocumentReviewJobs.hiveId, hiveReferenceDocumentReviewJobs.documentId],
  }).onDelete("cascade"),
]);
