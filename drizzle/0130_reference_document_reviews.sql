CREATE TABLE IF NOT EXISTS hive_reference_document_review_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES hive_reference_documents(id) ON DELETE CASCADE,
  status varchar(64) NOT NULL DEFAULT 'pending',
  error text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (document_id)
);

CREATE INDEX IF NOT EXISTS hive_reference_document_review_jobs_hive_status_idx
  ON hive_reference_document_review_jobs (hive_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS hive_reference_document_record_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_job_id uuid NOT NULL REFERENCES hive_reference_document_review_jobs(id) ON DELETE CASCADE,
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES hive_reference_documents(id) ON DELETE CASCADE,
  proposed_category varchar(128) NOT NULL,
  proposed_record_type varchar(128) NOT NULL DEFAULT 'document_context',
  title text NOT NULL,
  summary text,
  source_excerpt text,
  source_page text,
  confidence numeric(5,4),
  suggested_status varchar(64) NOT NULL DEFAULT 'needs_confirmation',
  decision varchar(64) NOT NULL DEFAULT 'pending',
  decision_notes text,
  accepted_record_id uuid REFERENCES business_records(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hive_reference_document_record_proposals_job_idx
  ON hive_reference_document_record_proposals (review_job_id, created_at);

CREATE INDEX IF NOT EXISTS hive_reference_document_record_proposals_hive_decision_idx
  ON hive_reference_document_record_proposals (hive_id, decision, created_at DESC);

INSERT INTO role_templates (
  slug,
  name,
  department,
  type,
  delegates_to,
  recommended_model,
  adapter_type,
  skills,
  terminal,
  active,
  updated_at
)
VALUES (
  'reference-document-reviewer',
  'Reference Document Reviewer',
  'administration',
  'executor',
  '[]'::jsonb,
  'auto',
  'auto',
  '["hivewright-ops"]'::jsonb,
  true,
  true,
  NOW()
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    department = EXCLUDED.department,
    type = EXCLUDED.type,
    delegates_to = EXCLUDED.delegates_to,
    recommended_model = COALESCE(role_templates.recommended_model, EXCLUDED.recommended_model),
    adapter_type = COALESCE(role_templates.adapter_type, EXCLUDED.adapter_type),
    skills = EXCLUDED.skills,
    terminal = EXCLUDED.terminal,
    active = true,
    updated_at = NOW();
