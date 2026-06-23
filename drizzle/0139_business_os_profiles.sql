CREATE TABLE IF NOT EXISTS business_os_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  business_mode varchar(32) NOT NULL,
  business_name text NOT NULL,
  industry text,
  stage varchar(64),
  summary text,
  owner_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_spend_budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  autonomy_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_os_profiles_mode_check CHECK (business_mode IN ('new_business', 'existing_business')),
  CONSTRAINT business_os_profiles_owner_goals_array_check CHECK (jsonb_typeof(owner_goals) = 'array'),
  CONSTRAINT business_os_profiles_constraints_array_check CHECK (jsonb_typeof(constraints) = 'array'),
  CONSTRAINT business_os_profiles_approval_policy_object_check CHECK (jsonb_typeof(approval_policy) = 'object'),
  CONSTRAINT business_os_profiles_ai_spend_budget_object_check CHECK (jsonb_typeof(ai_spend_budget) = 'object'),
  CONSTRAINT business_os_profiles_autonomy_policy_object_check CHECK (jsonb_typeof(autonomy_policy) = 'object'),
  CONSTRAINT business_os_profiles_source_profile_object_check CHECK (jsonb_typeof(source_profile) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS business_os_profiles_hive_unique
  ON business_os_profiles (hive_id);

CREATE INDEX IF NOT EXISTS business_os_profiles_mode_idx
  ON business_os_profiles (business_mode);
