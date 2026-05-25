DROP INDEX IF EXISTS business_records_source_key_idx;

ALTER TABLE business_records
  DROP CONSTRAINT IF EXISTS business_records_source_key_idx;

ALTER TABLE business_records
  ADD CONSTRAINT business_records_source_key_idx
  UNIQUE NULLS NOT DISTINCT (
    hive_id,
    connector_install_id,
    source_connector,
    external_id,
    record_type
  );

CREATE TABLE IF NOT EXISTS connector_webhook_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  install_id uuid NOT NULL REFERENCES connector_installs(id) ON DELETE CASCADE,
  stream varchar(128) NOT NULL DEFAULT 'default',
  label varchar(255),
  token_hash varchar(64) NOT NULL,
  last_used_at timestamp,
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_webhook_tokens_hash_idx
  ON connector_webhook_tokens (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS connector_webhook_tokens_install_stream_idx
  ON connector_webhook_tokens (install_id, stream);
