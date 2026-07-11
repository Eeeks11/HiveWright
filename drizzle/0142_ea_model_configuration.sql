CREATE TABLE IF NOT EXISTS "ea_model_configurations" (
  "hive_id" uuid PRIMARY KEY NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "primary_model" varchar(255),
  "fallback_model" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Existing EA installs previously stored one transport-local model override.
-- Preserve an explicit override, canonicalize the old GPT-5.6 alias to Sol,
-- and give configured EA hives a durable healthy-fallback target.
INSERT INTO "ea_model_configurations" ("hive_id", "primary_model", "fallback_model")
SELECT DISTINCT ON (ci.hive_id)
  ci.hive_id,
  CASE
    WHEN NULLIF(BTRIM(ci.config->>'model'), '') IN ('gpt-5.6', 'openai-codex/gpt-5.6')
      THEN 'openai-codex/gpt-5.6-sol'
    ELSE COALESCE(NULLIF(BTRIM(ci.config->>'model'), ''), 'openai-codex/gpt-5.6-sol')
  END,
  'openai-codex/gpt-5.5'
FROM connector_installs ci
WHERE ci.connector_slug IN ('ea-discord', 'voice-ea')
  AND ci.status = 'active'
ORDER BY ci.hive_id, ci.updated_at DESC, ci.created_at DESC
ON CONFLICT (hive_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS "ea_model_route_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "transport" varchar(32) NOT NULL,
  "voice_session_id" uuid REFERENCES "voice_sessions"("id") ON DELETE CASCADE,
  "selected" varchar(32) NOT NULL,
  "model_id" varchar(255),
  "reason" varchar(255) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ea_model_route_events_hive_created_idx"
  ON "ea_model_route_events" ("hive_id", "created_at");

CREATE INDEX IF NOT EXISTS "ea_model_route_events_voice_session_idx"
  ON "ea_model_route_events" ("voice_session_id", "created_at")
  WHERE "voice_session_id" IS NOT NULL;
