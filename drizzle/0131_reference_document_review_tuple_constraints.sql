DROP INDEX IF EXISTS hive_reference_document_review_jobs_document_idx;
ALTER TABLE hive_reference_document_review_jobs
  DROP CONSTRAINT IF EXISTS hive_reference_document_review_jobs_document_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS hive_reference_document_review_jobs_hive_document_idx
  ON hive_reference_document_review_jobs (hive_id, document_id);

CREATE UNIQUE INDEX IF NOT EXISTS hive_reference_document_review_jobs_tuple_idx
  ON hive_reference_document_review_jobs (id, hive_id, document_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'hive_reference_document_record_proposals_job_tuple_fk'
      AND conrelid = 'hive_reference_document_record_proposals'::regclass
  ) THEN
    ALTER TABLE hive_reference_document_record_proposals
      DROP CONSTRAINT hive_reference_document_record_proposals_job_tuple_fk;
  END IF;

  ALTER TABLE hive_reference_document_record_proposals
    ADD CONSTRAINT hive_reference_document_record_proposals_job_tuple_fk
    FOREIGN KEY (review_job_id, hive_id, document_id)
    REFERENCES hive_reference_document_review_jobs (id, hive_id, document_id)
    ON DELETE CASCADE;
END $$;
