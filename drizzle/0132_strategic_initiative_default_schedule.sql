-- Add the replacement strategic initiative loop as a separate system default.
-- This does not re-enable legacy dormant-goal initiative-evaluation schedules;
-- those remain supervisor-heartbeat recovery semantics.
INSERT INTO schedules (
  hive_id,
  cron_expression,
  task_template,
  enabled,
  next_run_at,
  created_by,
  origin_type,
  origin_key
)
SELECT
  h.id,
  '0 */6 * * *',
  jsonb_build_object(
    'kind', 'strategic-initiative-evaluation',
    'assignedTo', 'initiative-engine',
    'title', 'Strategic initiative evaluation',
    'brief', 'Hive-scoped mission/target review; starts or advances work only when a clear high-leverage next move exists.',
    'qaRequired', false,
    'priority', 3
  ),
  true,
  NOW() + interval '30 minutes',
  'system:seed-default-schedules',
  'system_default',
  'strategic-initiative-evaluation'
FROM hives h
WHERE NOT EXISTS (
  SELECT 1
  FROM schedules s
  WHERE s.hive_id = h.id
    AND s.origin_type = 'system_default'
    AND s.origin_key = 'strategic-initiative-evaluation'
);
