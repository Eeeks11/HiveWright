CREATE TABLE IF NOT EXISTS marketing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  industry text NOT NULL,
  target_customers jsonb NOT NULL DEFAULT '[]'::jsonb,
  offers jsonb NOT NULL DEFAULT '[]'::jsonb,
  service_areas jsonb NOT NULL DEFAULT '[]'::jsonb,
  average_customer_value_cents integer,
  capacity_constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  seasonality jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand_voice text,
  forbidden_claims jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT marketing_profiles_target_customers_array_check CHECK (jsonb_typeof(target_customers) = 'array'),
  CONSTRAINT marketing_profiles_offers_array_check CHECK (jsonb_typeof(offers) = 'array'),
  CONSTRAINT marketing_profiles_service_areas_array_check CHECK (jsonb_typeof(service_areas) = 'array'),
  CONSTRAINT marketing_profiles_capacity_constraints_array_check CHECK (jsonb_typeof(capacity_constraints) = 'array'),
  CONSTRAINT marketing_profiles_seasonality_object_check CHECK (jsonb_typeof(seasonality) = 'object'),
  CONSTRAINT marketing_profiles_forbidden_claims_array_check CHECK (jsonb_typeof(forbidden_claims) = 'array'),
  CONSTRAINT marketing_profiles_approval_policy_object_check CHECK (jsonb_typeof(approval_policy) = 'object'),
  CONSTRAINT marketing_profiles_connected_channels_array_check CHECK (jsonb_typeof(connected_channels) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_profiles_hive_unique
  ON marketing_profiles (hive_id);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES marketing_profiles(id) ON DELETE SET NULL,
  growth_loop_template_id uuid REFERENCES growth_loop_templates(id) ON DELETE SET NULL,
  growth_loop_run_id uuid REFERENCES growth_loop_runs(id) ON DELETE SET NULL,
  objective text NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'idea',
  channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_audience text,
  offer text,
  spend_budget_cents integer,
  success_metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  start_at timestamp,
  end_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT marketing_campaigns_status_check CHECK (status IN ('idea', 'draft', 'approval', 'approved', 'running', 'paused', 'completed', 'killed')),
  CONSTRAINT marketing_campaigns_channels_array_check CHECK (jsonb_typeof(channels) = 'array'),
  CONSTRAINT marketing_campaigns_success_metrics_array_check CHECK (jsonb_typeof(success_metrics) = 'array'),
  CONSTRAINT marketing_campaigns_approval_policy_object_check CHECK (jsonb_typeof(approval_policy) = 'object')
);

CREATE INDEX IF NOT EXISTS marketing_campaigns_hive_status_idx
  ON marketing_campaigns (hive_id, status);

CREATE INDEX IF NOT EXISTS marketing_campaigns_loop_run_idx
  ON marketing_campaigns (growth_loop_run_id);

CREATE TABLE IF NOT EXISTS marketing_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  external_action_request_id uuid REFERENCES external_action_requests(id) ON DELETE SET NULL,
  asset_type varchar(64) NOT NULL,
  channel varchar(64) NOT NULL,
  title text NOT NULL,
  draft_body text NOT NULL,
  variants jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_status varchar(32) NOT NULL DEFAULT 'pending_owner_approval',
  publication_status varchar(32) NOT NULL DEFAULT 'draft',
  scheduled_for timestamp,
  published_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT marketing_assets_approval_status_check CHECK (approval_status IN ('pending_owner_approval', 'approved', 'rejected')),
  CONSTRAINT marketing_assets_publication_status_check CHECK (publication_status IN ('draft', 'queued', 'published', 'blocked')),
  CONSTRAINT marketing_assets_variants_array_check CHECK (jsonb_typeof(variants) = 'array')
);

CREATE INDEX IF NOT EXISTS marketing_assets_hive_approval_idx
  ON marketing_assets (hive_id, approval_status);

CREATE INDEX IF NOT EXISTS marketing_assets_campaign_status_idx
  ON marketing_assets (campaign_id, publication_status);

CREATE INDEX IF NOT EXISTS marketing_assets_external_action_request_idx
  ON marketing_assets (external_action_request_id);

CREATE TABLE IF NOT EXISTS marketing_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  source varchar(64) NOT NULL DEFAULT 'manual_import',
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  attribution_confidence varchar(32) NOT NULL DEFAULT 'manual_unverified',
  freshness varchar(32) NOT NULL DEFAULT 'current',
  connector_error text,
  captured_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT marketing_metric_snapshots_values_object_check CHECK (jsonb_typeof(values) = 'object'),
  CONSTRAINT marketing_metric_snapshots_attribution_check CHECK (attribution_confidence IN ('manual_unverified', 'imported', 'connector_verified')),
  CONSTRAINT marketing_metric_snapshots_freshness_check CHECK (freshness IN ('current', 'stale', 'missing'))
);

CREATE INDEX IF NOT EXISTS marketing_metric_snapshots_hive_captured_idx
  ON marketing_metric_snapshots (hive_id, captured_at);

CREATE INDEX IF NOT EXISTS marketing_metric_snapshots_campaign_captured_idx
  ON marketing_metric_snapshots (campaign_id, captured_at);

CREATE TABLE IF NOT EXISTS marketing_execution_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES marketing_assets(id) ON DELETE SET NULL,
  external_action_request_id uuid REFERENCES external_action_requests(id) ON DELETE SET NULL,
  action text NOT NULL,
  connector varchar(64) NOT NULL DEFAULT 'manual_import',
  trace jsonb NOT NULL DEFAULT '[]'::jsonb,
  executed_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT marketing_execution_logs_trace_array_check CHECK (jsonb_typeof(trace) = 'array')
);

CREATE INDEX IF NOT EXISTS marketing_execution_logs_campaign_executed_idx
  ON marketing_execution_logs (campaign_id, executed_at);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_execution_logs_external_action_request_unique
  ON marketing_execution_logs (external_action_request_id)
  WHERE external_action_request_id IS NOT NULL;
