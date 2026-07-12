import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { goals } from "./goals";

export const goalComments = pgTable(
  "goal_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    goalId: uuid("goal_id")
      .references(() => goals.id, { onDelete: "cascade" })
      .notNull(),
    body: text("body").notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull().default("owner"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    supervisorWakeStatus: varchar("supervisor_wake_status", { length: 24 })
      .notNull()
      .default("pending"),
    supervisorWakeClaimedAt: timestamp("supervisor_wake_claimed_at"),
    supervisorWokenAt: timestamp("supervisor_woken_at"),
    supervisorWakeAttempts: integer("supervisor_wake_attempts").notNull().default(0),
  },
  (t) => ({
    goalIdCreatedAtIdx: index("goal_comments_goal_id_created_at_idx").on(
      t.goalId,
      t.createdAt.desc().nullsFirst(),
    ),
    supervisorWakePendingIdx: index("goal_comments_supervisor_wake_pending_idx").on(
      t.supervisorWakeStatus,
      t.supervisorWakeClaimedAt,
      t.createdAt,
    ),
  }),
);
