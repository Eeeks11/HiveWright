CREATE UNIQUE INDEX IF NOT EXISTS "initiative_runs_release_scan_running_trigger_idx"
  ON "initiative_runs" ("hive_id", "trigger_type", "trigger_ref")
  WHERE "status" = 'running'
    AND "trigger_type" = 'llm-release-scan'
    AND "trigger_ref" IS NOT NULL;
