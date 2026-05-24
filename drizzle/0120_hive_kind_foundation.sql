ALTER TABLE hives
  ADD COLUMN IF NOT EXISTS kind varchar(50) NOT NULL DEFAULT 'business';

ALTER TABLE hives
  ADD COLUMN IF NOT EXISTS operating_mode varchar(50) NOT NULL DEFAULT 'exploring';

UPDATE hives
SET kind = 'business'
WHERE kind IS NULL OR kind = '';

UPDATE hives
SET operating_mode = 'exploring'
WHERE operating_mode IS NULL OR operating_mode = '';

DO $$
BEGIN
  ALTER TABLE hives
    ADD CONSTRAINT hives_kind_check
    CHECK (kind IN ('business', 'personal_project', 'personal_assistant', 'research', 'creative'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE hives
    ADD CONSTRAINT hives_operating_mode_check
    CHECK (operating_mode IN ('exploring', 'validating', 'active', 'paused', 'completed', 'killed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
