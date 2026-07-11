CREATE TABLE IF NOT EXISTS "owner_bootstrap_state" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK (id),
  "token_hash" char(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);

-- Any user row proves this installation was initialized before secure owner
-- bootstrap existed. Persist a consumed singleton so later user deletion can
-- never make a restart mint a new remote owner-claim token.
INSERT INTO "owner_bootstrap_state" ("id", "token_hash", "consumed_at")
SELECT
  true,
  '74e9d9482f912aa63612763a8ca8c31bfbd42dc55951af5d1b433c3a4653cb0a',
  now()
WHERE EXISTS (SELECT 1 FROM "users")
ON CONFLICT ("id") DO UPDATE
SET "consumed_at" = COALESCE("owner_bootstrap_state"."consumed_at", EXCLUDED."consumed_at");

CREATE TABLE IF NOT EXISTS "owner_bootstrap_attempts" (
  "id" bigserial PRIMARY KEY,
  "source_key" char(64) NOT NULL,
  "outcome" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "owner_bootstrap_attempts_source_created_idx"
  ON "owner_bootstrap_attempts" ("source_key", "created_at" DESC);

-- Only a truly empty installation reaches provisioning without durable state.
