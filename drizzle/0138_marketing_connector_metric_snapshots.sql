ALTER TABLE marketing_metric_snapshots
  ADD COLUMN IF NOT EXISTS connector_install_id uuid REFERENCES connector_installs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_connector varchar(128),
  ADD COLUMN IF NOT EXISTS source_stream varchar(128),
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS trust_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  ALTER TABLE marketing_metric_snapshots
    ADD CONSTRAINT marketing_metric_snapshots_trust_metadata_object_check
    CHECK (jsonb_typeof(trust_metadata) = 'object');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS marketing_metric_snapshots_connector_idx
  ON marketing_metric_snapshots (hive_id, source_connector, source_stream, captured_at);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_metric_snapshots_connector_external_unique
  ON marketing_metric_snapshots (hive_id, connector_install_id, source_connector, source_stream, external_id)
  WHERE connector_install_id IS NOT NULL AND external_id IS NOT NULL;
