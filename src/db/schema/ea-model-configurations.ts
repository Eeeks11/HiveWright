import { bigserial, index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hives } from "./hives";
import { voiceSessions } from "./voice-sessions";

export const eaModelConfigurations = pgTable("ea_model_configurations", {
  hiveId: uuid("hive_id")
    .primaryKey()
    .references(() => hives.id, { onDelete: "cascade" }),
  primaryModel: varchar("primary_model", { length: 255 }),
  fallbackModel: varchar("fallback_model", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const eaModelRouteEvents = pgTable(
  "ea_model_route_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    transport: varchar("transport", { length: 32 }).notNull(),
    voiceSessionId: uuid("voice_session_id").references(() => voiceSessions.id, { onDelete: "cascade" }),
    selected: varchar("selected", { length: 32 }).notNull(),
    modelId: varchar("model_id", { length: 255 }),
    reason: varchar("reason", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ea_model_route_events_hive_created_idx").on(table.hiveId, table.createdAt),
    index("ea_model_route_events_voice_session_idx")
      .on(table.voiceSessionId, table.createdAt)
      .where(sql`${table.voiceSessionId} IS NOT NULL`),
  ],
);
