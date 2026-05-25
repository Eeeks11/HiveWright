CREATE TABLE IF NOT EXISTS hive_operating_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  kind varchar(50) NOT NULL,
  purpose text NOT NULL,
  desired_outcome text NOT NULL,
  current_30_day_outcome text,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  forbidden_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  important_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  success_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  stop_or_pause_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  kind_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT hive_operating_profiles_kind_check
    CHECK (kind IN ('business', 'personal_project', 'personal_assistant', 'research', 'creative'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hive_operating_profiles_hive_id_unique
  ON hive_operating_profiles (hive_id);

CREATE INDEX IF NOT EXISTS hive_operating_profiles_kind_idx
  ON hive_operating_profiles (kind);
