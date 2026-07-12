ALTER TABLE "goal_comments"
  ADD COLUMN IF NOT EXISTS "supervisor_wake_status" varchar(24) DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS "supervisor_wake_claimed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "supervisor_woken_at" timestamp,
  ADD COLUMN IF NOT EXISTS "supervisor_wake_attempts" integer DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "goal_comments_supervisor_wake_pending_idx"
  ON "goal_comments" ("supervisor_wake_status", "supervisor_wake_claimed_at", "created_at");
