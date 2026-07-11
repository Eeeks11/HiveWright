CREATE TABLE IF NOT EXISTS sales_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  name text NOT NULL,
  source varchar(64) NOT NULL DEFAULT 'manual_import',
  customer_type varchar(32) NOT NULL DEFAULT 'lead',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT sales_segments_source_check CHECK (source IN ('manual_import', 'business_records', 'connector')),
  CONSTRAINT sales_segments_customer_type_check CHECK (customer_type IN ('lead', 'customer', 'dormant_customer')),
  CONSTRAINT sales_segments_filters_object_check CHECK (jsonb_typeof(filters) = 'object')
);

CREATE INDEX IF NOT EXISTS sales_segments_hive_idx
  ON sales_segments (hive_id);

CREATE TABLE IF NOT EXISTS sales_funnels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  segment_id uuid REFERENCES sales_segments(id) ON DELETE SET NULL,
  goal text NOT NULL,
  stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  biggest_leak jsonb NOT NULL DEFAULT '{}'::jsonb,
  source varchar(64) NOT NULL DEFAULT 'manual_import',
  captured_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT sales_funnels_stages_array_check CHECK (jsonb_typeof(stages) = 'array'),
  CONSTRAINT sales_funnels_biggest_leak_object_check CHECK (jsonb_typeof(biggest_leak) = 'object')
);

CREATE INDEX IF NOT EXISTS sales_funnels_hive_captured_idx
  ON sales_funnels (hive_id, captured_at);

CREATE TABLE IF NOT EXISTS sales_action_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  funnel_id uuid NOT NULL REFERENCES sales_funnels(id) ON DELETE CASCADE,
  bottleneck jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(32) NOT NULL DEFAULT 'draft',
  bounded_by text NOT NULL,
  approval_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_measurement text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT sales_action_plans_status_check CHECK (status IN ('draft', 'approval', 'running', 'completed')),
  CONSTRAINT sales_action_plans_bottleneck_object_check CHECK (jsonb_typeof(bottleneck) = 'object'),
  CONSTRAINT sales_action_plans_approval_policy_object_check CHECK (jsonb_typeof(approval_policy) = 'object')
);

CREATE INDEX IF NOT EXISTS sales_action_plans_hive_status_idx
  ON sales_action_plans (hive_id, status);

CREATE TABLE IF NOT EXISTS sales_action_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  action_plan_id uuid NOT NULL REFERENCES sales_action_plans(id) ON DELETE CASCADE,
  external_action_request_id uuid REFERENCES external_action_requests(id) ON DELETE SET NULL,
  workflow varchar(64) NOT NULL,
  title text NOT NULL,
  draft_body text NOT NULL,
  approval_status varchar(32) NOT NULL DEFAULT 'pending_owner_approval',
  execution_status varchar(32) NOT NULL DEFAULT 'draft',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT sales_action_drafts_workflow_check CHECK (workflow IN ('reactivation', 'lead_follow_up', 'review_referral', 'missed_call_recovery', 'sales_training')),
  CONSTRAINT sales_action_drafts_approval_status_check CHECK (approval_status IN ('pending_owner_approval', 'approved', 'rejected')),
  CONSTRAINT sales_action_drafts_execution_status_check CHECK (execution_status IN ('draft', 'queued', 'executed', 'blocked'))
);

CREATE INDEX IF NOT EXISTS sales_action_drafts_hive_approval_idx
  ON sales_action_drafts (hive_id, approval_status);

CREATE INDEX IF NOT EXISTS sales_action_drafts_action_plan_idx
  ON sales_action_drafts (action_plan_id);

CREATE INDEX IF NOT EXISTS sales_action_drafts_external_action_request_idx
  ON sales_action_drafts (external_action_request_id);

CREATE TABLE IF NOT EXISTS sales_execution_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  action_plan_id uuid NOT NULL REFERENCES sales_action_plans(id) ON DELETE CASCADE,
  action_draft_id uuid REFERENCES sales_action_drafts(id) ON DELETE SET NULL,
  external_action_request_id uuid REFERENCES external_action_requests(id) ON DELETE SET NULL,
  workflow varchar(64) NOT NULL,
  connector varchar(64) NOT NULL DEFAULT 'manual_queue',
  trace jsonb NOT NULL DEFAULT '[]'::jsonb,
  executed_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT sales_execution_logs_trace_array_check CHECK (jsonb_typeof(trace) = 'array')
);

CREATE INDEX IF NOT EXISTS sales_execution_logs_action_plan_executed_idx
  ON sales_execution_logs (action_plan_id, executed_at);

CREATE UNIQUE INDEX IF NOT EXISTS sales_execution_logs_external_action_request_unique
  ON sales_execution_logs (external_action_request_id)
  WHERE external_action_request_id IS NOT NULL;
