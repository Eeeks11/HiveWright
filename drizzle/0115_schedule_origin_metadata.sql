ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS origin_type varchar(32) NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS origin_key varchar(128);

WITH default_matches AS (
  SELECT
    id,
    CASE
      WHEN task_template ->> 'title' = 'Daily world scan'
        OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"title"[[:space:]]*:[[:space:]]*"Daily world scan"')
        THEN 'daily-world-scan'
      WHEN task_template ->> 'kind' = 'hive-supervisor-heartbeat'
        OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"hive-supervisor-heartbeat"')
        THEN 'hive-supervisor-heartbeat'
      WHEN task_template ->> 'kind' = 'ideas-daily-review'
        OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"ideas-daily-review"')
        THEN 'ideas-daily-review'
      WHEN task_template ->> 'kind' = 'initiative-evaluation'
        OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"initiative-evaluation"')
        THEN 'initiative-evaluation'
      WHEN task_template ->> 'kind' = 'llm-release-scan'
        OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"llm-release-scan"')
        THEN 'llm-release-scan'
      WHEN task_template ->> 'kind' = 'current-tech-research-daily'
        OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"current-tech-research-daily"')
        THEN 'current-tech-research-daily'
      WHEN task_template ->> 'kind' = 'task-quality-feedback-sample'
        OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"task-quality-feedback-sample"')
        THEN 'task-quality-feedback-sample'
      ELSE NULL
    END AS origin_key,
    ROW_NUMBER() OVER (
      PARTITION BY hive_id,
        CASE
          WHEN task_template ->> 'title' = 'Daily world scan'
            OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"title"[[:space:]]*:[[:space:]]*"Daily world scan"')
            THEN 'daily-world-scan'
          WHEN task_template ->> 'kind' = 'hive-supervisor-heartbeat'
            OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"hive-supervisor-heartbeat"')
            THEN 'hive-supervisor-heartbeat'
          WHEN task_template ->> 'kind' = 'ideas-daily-review'
            OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"ideas-daily-review"')
            THEN 'ideas-daily-review'
          WHEN task_template ->> 'kind' = 'initiative-evaluation'
            OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"initiative-evaluation"')
            THEN 'initiative-evaluation'
          WHEN task_template ->> 'kind' = 'llm-release-scan'
            OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"llm-release-scan"')
            THEN 'llm-release-scan'
          WHEN task_template ->> 'kind' = 'current-tech-research-daily'
            OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"current-tech-research-daily"')
            THEN 'current-tech-research-daily'
          WHEN task_template ->> 'kind' = 'task-quality-feedback-sample'
            OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"kind"[[:space:]]*:[[:space:]]*"task-quality-feedback-sample"')
            THEN 'task-quality-feedback-sample'
          ELSE NULL
        END
      ORDER BY created_at ASC, id ASC
    ) AS rank_for_default
  FROM schedules
  WHERE created_by IN ('system:seed-default-schedules', 'system:default-schedule', 'migration:0031_hive_supervisor')
     OR task_template ->> 'title' = 'Daily world scan'
     OR task_template ->> 'kind' IN (
       'hive-supervisor-heartbeat',
       'ideas-daily-review',
       'initiative-evaluation',
       'llm-release-scan',
       'current-tech-research-daily',
       'task-quality-feedback-sample'
     )
     OR (jsonb_typeof(task_template) = 'string' AND task_template #>> '{}' ~ '"(kind|title)"')
)
UPDATE schedules s
SET origin_type = 'system_default',
    origin_key = default_matches.origin_key
FROM default_matches
WHERE s.id = default_matches.id
  AND default_matches.origin_key IS NOT NULL
  AND default_matches.rank_for_default = 1;

CREATE UNIQUE INDEX IF NOT EXISTS schedules_one_default_per_hive
  ON schedules (hive_id, origin_type, origin_key)
  WHERE origin_type = 'system_default' AND origin_key IS NOT NULL;
