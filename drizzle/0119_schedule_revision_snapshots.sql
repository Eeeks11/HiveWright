ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS schedule_revision_snapshot jsonb;

CREATE TABLE IF NOT EXISTS schedule_fire_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  snapshot_hash varchar(71) NOT NULL,
  snapshot jsonb NOT NULL,
  fired_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS schedule_fire_snapshots_schedule_id_idx
  ON schedule_fire_snapshots (schedule_id);

CREATE INDEX IF NOT EXISTS schedule_fire_snapshots_task_id_idx
  ON schedule_fire_snapshots (task_id);

CREATE INDEX IF NOT EXISTS schedule_fire_snapshots_snapshot_hash_idx
  ON schedule_fire_snapshots (snapshot_hash);
