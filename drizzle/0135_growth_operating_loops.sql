CREATE TABLE IF NOT EXISTS growth_loop_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid REFERENCES hives(id) ON DELETE CASCADE,
  domain varchar(32) NOT NULL,
  slug varchar(128) NOT NULL,
  name text NOT NULL,
  objective text NOT NULL,
  stages jsonb NOT NULL,
  success_metric text NOT NULL,
  owner_visible_output_policy varchar(32) NOT NULL,
  default_autonomy_level integer NOT NULL DEFAULT 1,
  approval_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT growth_loop_templates_domain_check CHECK (domain IN ('marketing-attention', 'sales-conversion')),
  CONSTRAINT growth_loop_templates_stages_array_check CHECK (jsonb_typeof(stages) = 'array'),
  CONSTRAINT growth_loop_templates_owner_output_policy_check CHECK (owner_visible_output_policy IN ('exception-only', 'approval-request', 'weekly-summary')),
  CONSTRAINT growth_loop_templates_autonomy_level_check CHECK (default_autonomy_level >= 0 AND default_autonomy_level <= 5),
  CONSTRAINT growth_loop_templates_approval_policy_object_check CHECK (jsonb_typeof(approval_policy) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS growth_loop_templates_hive_slug_unique
  ON growth_loop_templates (hive_id, slug) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS growth_loop_templates_hive_domain_idx
  ON growth_loop_templates (hive_id, domain);

CREATE TABLE IF NOT EXISTS growth_loop_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  template_id uuid REFERENCES growth_loop_templates(id) ON DELETE SET NULL,
  domain varchar(32) NOT NULL,
  stage varchar(32) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'queued',
  cycle_key varchar(128) NOT NULL,
  inputs_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  outputs_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  stage_state jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_stage varchar(32),
  approvals_required jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_action_request_id uuid REFERENCES external_action_requests(id) ON DELETE SET NULL,
  metrics_snapshot_record_id uuid REFERENCES business_records(id) ON DELETE SET NULL,
  optimiser_decision varchar(32),
  owner_visible_output jsonb NOT NULL DEFAULT '{}'::jsonb,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamp,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT growth_loop_runs_domain_check CHECK (domain IN ('marketing-attention', 'sales-conversion')),
  CONSTRAINT growth_loop_runs_stage_check CHECK (stage IN ('observe', 'plan', 'execute', 'measure', 'optimise')),
  CONSTRAINT growth_loop_runs_status_check CHECK (status IN ('queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled')),
  CONSTRAINT growth_loop_runs_next_stage_check CHECK (next_stage IS NULL OR next_stage IN ('observe', 'plan', 'execute', 'measure', 'optimise')),
  CONSTRAINT growth_loop_runs_inputs_array_check CHECK (jsonb_typeof(inputs_manifest) = 'array'),
  CONSTRAINT growth_loop_runs_outputs_array_check CHECK (jsonb_typeof(outputs_manifest) = 'array'),
  CONSTRAINT growth_loop_runs_stage_state_array_check CHECK (jsonb_typeof(stage_state) = 'array'),
  CONSTRAINT growth_loop_runs_approvals_array_check CHECK (jsonb_typeof(approvals_required) = 'array'),
  CONSTRAINT growth_loop_runs_owner_output_object_check CHECK (jsonb_typeof(owner_visible_output) = 'object'),
  CONSTRAINT growth_loop_runs_state_object_check CHECK (jsonb_typeof(state) = 'object'),
  CONSTRAINT growth_loop_runs_optimiser_decision_check CHECK (optimiser_decision IS NULL OR optimiser_decision IN ('kill', 'keep', 'change', 'scale', 'observe_more'))
);

CREATE INDEX IF NOT EXISTS growth_loop_runs_hive_domain_status_idx
  ON growth_loop_runs (hive_id, domain, status);

CREATE INDEX IF NOT EXISTS growth_loop_runs_hive_cycle_idx
  ON growth_loop_runs (hive_id, cycle_key);

CREATE INDEX IF NOT EXISTS growth_loop_runs_template_created_idx
  ON growth_loop_runs (template_id, created_at);

CREATE INDEX IF NOT EXISTS growth_loop_runs_external_action_request_idx
  ON growth_loop_runs (external_action_request_id);
