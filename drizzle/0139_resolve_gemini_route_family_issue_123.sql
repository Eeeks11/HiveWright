DO $$
DECLARE
  retired_models text[] := ARRAY[
    'google/gemini-2.0-flash',
    'google/gemini-2.0-flash-lite',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-flash-lite',
    'google/gemini-2.5-flash-lite-preview-09-2025',
    'google/gemini-2.5-flash-preview-09-2025',
    'google/gemini-2.5-pro',
    'google/gemini-3',
    'google/gemini-3-flash',
    'google/gemini-3-flash-preview',
    'google/gemini-3-pro-preview',
    'google/gemini-3.1-flash-lite-preview',
    'google/gemini-3.1-flash-live-preview',
    'google/gemini-3.1-pro',
    'google/gemini-3.1-pro-preview'
  ];
  retired_route_keys text[] := ARRAY[
    'google:gemini:google/gemini-2.0-flash',
    'google:gemini:google/gemini-2.0-flash-lite',
    'google:gemini:google/gemini-2.5-flash',
    'google:gemini:google/gemini-2.5-flash-lite',
    'google:gemini:google/gemini-2.5-flash-lite-preview-09-2025',
    'google:gemini:google/gemini-2.5-flash-preview-09-2025',
    'google:gemini:google/gemini-2.5-pro',
    'google:gemini:google/gemini-3',
    'google:gemini:google/gemini-3-flash',
    'google:gemini:google/gemini-3-flash-preview',
    'google:gemini:google/gemini-3-pro-preview',
    'google:gemini:google/gemini-3.1-flash-lite-preview',
    'google:gemini:google/gemini-3.1-flash-live-preview',
    'google:gemini:google/gemini-3.1-pro',
    'google:gemini:google/gemini-3.1-pro-preview'
  ];
BEGIN
  DELETE FROM hive_models
  WHERE provider = 'google'
    AND adapter_type = 'gemini'
    AND model_id = ANY(retired_models);

  UPDATE adapter_config ac
  SET config = jsonb_set(
    jsonb_set(
      jsonb_set(
        ac.config,
        '{candidates}',
        COALESCE((
          SELECT jsonb_agg(candidate)
          FROM jsonb_array_elements(COALESCE(ac.config->'candidates', '[]'::jsonb)) candidate
          WHERE NOT (
            candidate->>'adapterType' = 'gemini'
            AND candidate->>'model' = ANY(retired_models)
          )
        ), '[]'::jsonb),
        true
      ),
      '{routeOverrides}',
      COALESCE((
        SELECT jsonb_object_agg(key, value)
        FROM jsonb_each(COALESCE(ac.config->'routeOverrides', '{}'::jsonb)) AS overrides(key, value)
        WHERE key <> ALL(retired_route_keys)
      ), '{}'::jsonb),
      true
    ),
    '{roleRoutes}',
    COALESCE((
      SELECT jsonb_object_agg(role_key, sanitized_value)
      FROM (
        SELECT
          role_key,
          CASE
            WHEN filtered_models = '[]'::jsonb THEN NULL
            ELSE jsonb_set(role_value, '{candidateModels}', filtered_models, true)
          END AS sanitized_value
        FROM jsonb_each(COALESCE(ac.config->'roleRoutes', '{}'::jsonb)) AS roles(role_key, role_value)
        CROSS JOIN LATERAL (
          SELECT COALESCE(jsonb_agg(to_jsonb(model_text)), '[]'::jsonb) AS filtered_models
          FROM (
            SELECT model_text
            FROM jsonb_array_elements_text(COALESCE(role_value->'candidateModels', '[]'::jsonb)) AS candidate(model_text)
            WHERE model_text <> ALL(retired_models)
          ) filtered
        ) filtered_candidates
      ) sanitized
      WHERE sanitized_value IS NOT NULL
    ), '{}'::jsonb),
    true
  )
  WHERE ac.adapter_type = 'model-routing'
    AND ac.config::text ILIKE '%gemini%';
END $$;
