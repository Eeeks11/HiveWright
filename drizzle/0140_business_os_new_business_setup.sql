CREATE TABLE IF NOT EXISTS business_setup_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  business_os_profile_id uuid NOT NULL REFERENCES business_os_profiles(id) ON DELETE CASCADE,
  idea text NOT NULL,
  customer_segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  problem_statements jsonb NOT NULL DEFAULT '[]'::jsonb,
  offers jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand_positioning jsonb NOT NULL DEFAULT '{}'::jsonb,
  sales_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  marketing_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  admin_finance_model jsonb NOT NULL DEFAULT '{}'::jsonb,
  legal_compliance_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_stack jsonb NOT NULL DEFAULT '[]'::jsonb,
  roles_and_sops jsonb NOT NULL DEFAULT '[]'::jsonb,
  launch_plan_id uuid,
  readiness_snapshot_id uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_setup_profiles_customer_segments_array_check CHECK (jsonb_typeof(customer_segments) = 'array'),
  CONSTRAINT business_setup_profiles_problem_statements_array_check CHECK (jsonb_typeof(problem_statements) = 'array'),
  CONSTRAINT business_setup_profiles_offers_array_check CHECK (jsonb_typeof(offers) = 'array'),
  CONSTRAINT business_setup_profiles_pricing_model_object_check CHECK (jsonb_typeof(pricing_model) = 'object'),
  CONSTRAINT business_setup_profiles_brand_positioning_object_check CHECK (jsonb_typeof(brand_positioning) = 'object'),
  CONSTRAINT business_setup_profiles_sales_model_object_check CHECK (jsonb_typeof(sales_model) = 'object'),
  CONSTRAINT business_setup_profiles_marketing_model_object_check CHECK (jsonb_typeof(marketing_model) = 'object'),
  CONSTRAINT business_setup_profiles_delivery_model_object_check CHECK (jsonb_typeof(delivery_model) = 'object'),
  CONSTRAINT business_setup_profiles_admin_finance_model_object_check CHECK (jsonb_typeof(admin_finance_model) = 'object'),
  CONSTRAINT business_setup_profiles_legal_checklist_array_check CHECK (jsonb_typeof(legal_compliance_checklist) = 'array'),
  CONSTRAINT business_setup_profiles_tool_stack_array_check CHECK (jsonb_typeof(tool_stack) = 'array'),
  CONSTRAINT business_setup_profiles_roles_sops_array_check CHECK (jsonb_typeof(roles_and_sops) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS business_setup_profiles_hive_unique
  ON business_setup_profiles (hive_id);
CREATE INDEX IF NOT EXISTS business_setup_profiles_profile_idx
  ON business_setup_profiles (business_os_profile_id);

CREATE TABLE IF NOT EXISTS business_system_readiness (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  business_os_profile_id uuid NOT NULL REFERENCES business_os_profiles(id) ON DELETE CASCADE,
  source_kind varchar(32) NOT NULL,
  source_id uuid,
  system_key varchar(64) NOT NULL,
  system_label text NOT NULL,
  readiness_score integer NOT NULL,
  maturity_level varchar(32),
  confidence varchar(32),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_system_readiness_source_kind_check CHECK (source_kind IN ('setup', 'audit', 'manual_update', 'loop_measurement')),
  CONSTRAINT business_system_readiness_score_check CHECK (readiness_score >= 0 AND readiness_score <= 100),
  CONSTRAINT business_system_readiness_maturity_check CHECK (maturity_level IS NULL OR maturity_level IN ('missing', 'ad_hoc', 'defined', 'managed', 'optimising')),
  CONSTRAINT business_system_readiness_confidence_check CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  CONSTRAINT business_system_readiness_evidence_array_check CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS business_system_readiness_hive_system_idx
  ON business_system_readiness (hive_id, system_key);
CREATE INDEX IF NOT EXISTS business_system_readiness_profile_idx
  ON business_system_readiness (business_os_profile_id);

CREATE TABLE IF NOT EXISTS business_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  business_os_profile_id uuid NOT NULL REFERENCES business_os_profiles(id) ON DELETE CASCADE,
  system_readiness_id uuid REFERENCES business_system_readiness(id) ON DELETE SET NULL,
  gap_type varchar(64),
  severity varchar(32),
  title text NOT NULL,
  description text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence varchar(32),
  status varchar(32) NOT NULL DEFAULT 'open',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_gaps_severity_check CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT business_gaps_status_check CHECK (status IN ('open', 'accepted', 'in_progress', 'resolved', 'deferred', 'rejected')),
  CONSTRAINT business_gaps_evidence_array_check CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS business_gaps_hive_status_idx
  ON business_gaps (hive_id, status);
CREATE INDEX IF NOT EXISTS business_gaps_profile_idx
  ON business_gaps (business_os_profile_id);

CREATE TABLE IF NOT EXISTS business_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  gap_id uuid REFERENCES business_gaps(id) ON DELETE CASCADE,
  recommendation_type varchar(64),
  title text NOT NULL,
  rationale text NOT NULL,
  expected_outcome text,
  estimated_effort varchar(32),
  risk_level varchar(32),
  requires_owner_approval boolean NOT NULL DEFAULT true,
  status varchar(32) NOT NULL DEFAULT 'proposed',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_recommendations_risk_check CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT business_recommendations_status_check CHECK (status IN ('proposed', 'accepted', 'rejected', 'converted_to_action', 'superseded'))
);

CREATE INDEX IF NOT EXISTS business_recommendations_hive_status_idx
  ON business_recommendations (hive_id, status);
CREATE INDEX IF NOT EXISTS business_recommendations_gap_idx
  ON business_recommendations (gap_id);

CREATE TABLE IF NOT EXISTS business_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  business_os_profile_id uuid NOT NULL REFERENCES business_os_profiles(id) ON DELETE CASCADE,
  recommendation_id uuid REFERENCES business_recommendations(id) ON DELETE SET NULL,
  system_key varchar(64),
  action_type varchar(64),
  title text NOT NULL,
  brief text NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'draft',
  priority integer NOT NULL DEFAULT 50,
  risk_level varchar(32),
  approval_required boolean NOT NULL DEFAULT true,
  external_action_request_id uuid REFERENCES external_action_requests(id) ON DELETE SET NULL,
  decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  assigned_role_slug varchar(128) REFERENCES role_templates(slug) ON DELETE SET NULL,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_outcome text,
  measurement_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at timestamp,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_actions_status_check CHECK (status IN ('draft', 'queued', 'awaiting_approval', 'approved', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
  CONSTRAINT business_actions_risk_check CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT business_actions_source_refs_array_check CHECK (jsonb_typeof(source_refs) = 'array'),
  CONSTRAINT business_actions_measurement_plan_object_check CHECK (jsonb_typeof(measurement_plan) = 'object')
);

CREATE INDEX IF NOT EXISTS business_actions_hive_status_priority_idx
  ON business_actions (hive_id, status, priority);
CREATE INDEX IF NOT EXISTS business_actions_profile_idx
  ON business_actions (business_os_profile_id);
CREATE INDEX IF NOT EXISTS business_actions_recommendation_idx
  ON business_actions (recommendation_id);
