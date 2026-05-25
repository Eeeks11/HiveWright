CREATE OR REPLACE FUNCTION "block_hive_creation_when_paused"()
RETURNS trigger AS $$
DECLARE
  lock_reason text;
BEGIN
  IF TG_TABLE_NAME = 'decisions' THEN
    IF NEW.kind = 'creation_pause_resume_approval' THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT reason
    INTO lock_reason
    FROM hive_runtime_locks
   WHERE hive_id = NEW.hive_id
     AND creation_paused = true
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'HIVE_CREATION_PAUSED: creation is paused for hive %: %',
      NEW.hive_id,
      COALESCE(lock_reason, 'No reason recorded')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
