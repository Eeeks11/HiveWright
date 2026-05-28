import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const hiveMemoryGovernance = pgTable("hive_memory_governance", {
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).primaryKey(),
  memoryDisabled: boolean("memory_disabled").default(false).notNull(),
  reason: text("reason"),
  changedBy: text("changed_by"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  lastWriteAt: timestamp("last_write_at"),
  lastBlockedAt: timestamp("last_blocked_at"),
  lastBlockedOperation: text("last_blocked_operation"),
  lastBlockedSource: text("last_blocked_source"),
});
