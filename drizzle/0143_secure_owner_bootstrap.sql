CREATE TABLE IF NOT EXISTS "owner_bootstrap_state" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK (id),
  "token_hash" char(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "owner_bootstrap_attempts" (
  "id" bigserial PRIMARY KEY,
  "source_key" char(64) NOT NULL,
  "outcome" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "owner_bootstrap_attempts_source_created_idx"
  ON "owner_bootstrap_attempts" ("source_key", "created_at" DESC);

-- Existing installations are deliberately not granted a bootstrap token by a
-- migration. Provisioning creates one only when there are no active users.
