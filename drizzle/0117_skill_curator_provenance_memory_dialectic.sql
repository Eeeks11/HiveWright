ALTER TABLE skill_drafts
  ADD COLUMN IF NOT EXISTS created_by varchar(30) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS curator_state varchar(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS curator_pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS patch_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamp,
  ADD COLUMN IF NOT EXISTS last_viewed_at timestamp,
  ADD COLUMN IF NOT EXISTS last_patched_at timestamp;
--> statement-breakpoint
UPDATE skill_drafts
SET created_by = CASE
    WHEN source_type = 'external' THEN 'user'
    WHEN internal_source_ref IS NULL AND source_task_id IS NULL AND originating_task_id IS NULL THEN 'user'
    ELSE created_by
  END
WHERE created_by = 'agent';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS skill_drafts_curator_idx
  ON skill_drafts (hive_id, created_by, curator_state, curator_pinned, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS skill_drafts_usage_idx
  ON skill_drafts (hive_id, last_used_at, last_viewed_at, last_patched_at);
