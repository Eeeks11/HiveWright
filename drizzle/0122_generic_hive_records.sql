ALTER TABLE business_records
  ADD COLUMN IF NOT EXISTS record_family varchar(128) NOT NULL DEFAULT 'event',
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS business_records_hive_recent_idx
  ON business_records (hive_id, occurred_at DESC NULLS LAST, created_at DESC);
