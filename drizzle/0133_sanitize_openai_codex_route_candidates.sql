UPDATE adapter_config
SET config = jsonb_set(
  config::jsonb,
  '{candidates}',
  COALESCE((
    SELECT jsonb_agg(candidate)
    FROM jsonb_array_elements(config::jsonb -> 'candidates') AS candidate
    WHERE NOT (
      lower(candidate ->> 'adapterType') = 'codex'
      AND COALESCE(candidate #>> '{canonicalRouteSet,source}', '') = 'configured_route_inventory'
      AND lower(candidate ->> 'model') NOT IN (
        'openai-codex/gpt-5.4',
        'openai-codex/gpt-5.4-mini',
        'openai-codex/gpt-5.5'
      )
    )
  ), '[]'::jsonb),
  true
)
WHERE adapter_type = 'model-routing'
  AND jsonb_typeof(config::jsonb -> 'candidates') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(config::jsonb -> 'candidates') AS candidate
    WHERE lower(candidate ->> 'adapterType') = 'codex'
      AND COALESCE(candidate #>> '{canonicalRouteSet,source}', '') = 'configured_route_inventory'
      AND lower(candidate ->> 'model') NOT IN (
        'openai-codex/gpt-5.4',
        'openai-codex/gpt-5.4-mini',
        'openai-codex/gpt-5.5'
      )
  );

DELETE FROM hive_models
WHERE provider = 'openai'
  AND adapter_type = 'codex'
  AND auto_discovered = true
  AND lower(model_id) NOT IN (
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.5'
  );

UPDATE model_catalog
SET stale_since = NOW(),
    updated_at = NOW()
WHERE provider = 'openai'
  AND adapter_type = 'codex'
  AND discovery_source = 'openai_public_model_docs'
  AND lower(model_id) NOT IN (
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.5'
  );

DELETE FROM model_catalog
WHERE provider = 'openai'
  AND adapter_type = 'codex'
  AND discovery_source = 'openai_public_model_docs'
  AND lower(model_id) NOT IN (
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM hive_models
    WHERE hive_models.model_catalog_id = model_catalog.id
  );
