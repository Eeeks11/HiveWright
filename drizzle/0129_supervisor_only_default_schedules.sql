-- Disable legacy/dev-era default schedules that no longer belong in every hive.
-- Keep rows/history/idempotency intact; only stop them from firing by default.
UPDATE schedules
SET enabled = false,
    next_run_at = NULL
WHERE origin_type = 'system_default'
  AND origin_key IN (
    'daily-world-scan',
    'weekly-business-review',
    'weekly-milestone-review',
    'project-blocker-check',
    'daily-admin-digest',
    'reminder-sweep',
    'source-finding-review',
    'research-unknowns-check',
    'creative-draft-review',
    'publish-readiness-loop',
    'ideas-daily-review',
    'initiative-evaluation',
    'llm-release-scan',
    'current-tech-research-daily',
    'task-quality-feedback-sample'
  );
