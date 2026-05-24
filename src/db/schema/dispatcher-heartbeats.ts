import { integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const dispatcherHeartbeats = pgTable("dispatcher_heartbeats", {
  dispatcherId: varchar("dispatcher_id", { length: 128 }).primaryKey(),
  pid: integer("pid").notNull(),
  hostId: varchar("host_id", { length: 255 }).notNull(),
  version: varchar("version", { length: 64 }),
  buildHash: varchar("build_hash", { length: 128 }),
  status: varchar("status", { length: 32 }).default("running").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: text("metadata"),
});
