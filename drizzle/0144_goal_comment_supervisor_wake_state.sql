ALTER TABLE "goal_comments"
  ADD COLUMN IF NOT EXISTS "supervisor_wake_status" varchar(24),
  ADD COLUMN IF NOT EXISTS "supervisor_wake_claimed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "supervisor_woken_at" timestamp,
  ADD COLUMN IF NOT EXISTS "supervisor_wake_attempts" integer;

-- Existing comments predate durable comment-wake reconciliation.  They have
-- already been observed by whatever supervisor state existed at the time, so
-- backfill them to a terminal state instead of replaying historical owner/system
-- comments as fresh wakes on deploy.  Future inserts get the pending default
-- after the legacy rows have been initialized.
UPDATE "goal_comments"
SET "supervisor_wake_status" = 'skipped'
WHERE "supervisor_wake_status" IS NULL;

UPDATE "goal_comments"
SET "supervisor_wake_attempts" = 0
WHERE "supervisor_wake_attempts" IS NULL;

ALTER TABLE "goal_comments"
  ALTER COLUMN "supervisor_wake_status" SET DEFAULT 'pending',
  ALTER COLUMN "supervisor_wake_status" SET NOT NULL,
  ALTER COLUMN "supervisor_wake_attempts" SET DEFAULT 0,
  ALTER COLUMN "supervisor_wake_attempts" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "goal_comments_supervisor_wake_pending_idx"
  ON "goal_comments" ("supervisor_wake_status", "supervisor_wake_claimed_at", "created_at");
