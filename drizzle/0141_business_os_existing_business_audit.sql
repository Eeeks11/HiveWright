CREATE TABLE IF NOT EXISTS business_audit_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  business_os_profile_id uuid NOT NULL REFERENCES business_os_profiles(id) ON DELETE CASCADE,
  audit_status varchar(32) NOT NULL DEFAULT 'draft',
  audit_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  known_unknowns jsonb NOT NULL DEFAULT '[]'::jsonb,
  overall_readiness_score integer,
  overall_confidence varchar(32),
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT business_audit_profiles_status_check CHECK (audit_status IN ('draft', 'in_progress', 'awaiting_owner_input', 'completed', 'superseded')),
  CONSTRAINT business_audit_profiles_scope_array_check CHECK (jsonb_typeof(audit_scope) = 'array'),
  CONSTRAINT business_audit_profiles_evidence_sources_array_check CHECK (jsonb_typeof(evidence_sources) = 'array'),
  CONSTRAINT business_audit_profiles_known_unknowns_array_check CHECK (jsonb_typeof(known_unknowns) = 'array'),
  CONSTRAINT business_audit_profiles_score_check CHECK (overall_readiness_score IS NULL OR (overall_readiness_score >= 0 AND overall_readiness_score <= 100)),
  CONSTRAINT business_audit_profiles_confidence_check CHECK (overall_confidence IS NULL OR overall_confidence IN ('low', 'medium', 'high'))
);

CREATE UNIQUE INDEX IF NOT EXISTS business_audit_profiles_hive_unique
  ON business_audit_profiles (hive_id);
CREATE INDEX IF NOT EXISTS business_audit_profiles_profile_idx
  ON business_audit_profiles (business_os_profile_id);
