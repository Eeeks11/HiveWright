CREATE TABLE IF NOT EXISTS "owner_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "goal_id" uuid NOT NULL,
  "goal_completion_id" uuid NOT NULL,
  "summary" text NOT NULL,
  "why_it_matters" text DEFAULT '' NOT NULL,
  "impact_statement" text DEFAULT '' NOT NULL,
  "recommended_next_action" text DEFAULT '' NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "primary_work_product_id" uuid,
  "primary_open_url" text,
  "primary_artifact_title" text,
  "primary_artifact_render_mode" varchar(30),
  "review_state" varchar(50) DEFAULT 'new' NOT NULL,
  "route_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reviewed_by" text,
  "reviewed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "owner_outcomes_goal_completion_unique" UNIQUE ("goal_completion_id"),
  CONSTRAINT "owner_outcomes_review_state_check" CHECK ("review_state" IN (
    'new',
    'accepted',
    'needs_revision',
    'archived',
    'converted_to_process_candidate'
  ))
);
--> statement-breakpoint
ALTER TABLE "owner_outcomes"
  ADD CONSTRAINT "owner_outcomes_hive_id_hives_id_fk"
  FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "owner_outcomes"
  ADD CONSTRAINT "owner_outcomes_goal_id_goals_id_fk"
  FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "owner_outcomes"
  ADD CONSTRAINT "owner_outcomes_goal_completion_id_goal_completions_id_fk"
  FOREIGN KEY ("goal_completion_id") REFERENCES "public"."goal_completions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "owner_outcomes"
  ADD CONSTRAINT "owner_outcomes_primary_work_product_id_work_products_id_fk"
  FOREIGN KEY ("primary_work_product_id") REFERENCES "public"."work_products"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owner_outcomes_hive_review_created_idx"
  ON "owner_outcomes" ("hive_id", "review_state", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owner_outcomes_goal_created_idx"
  ON "owner_outcomes" ("goal_id", "created_at" DESC);
--> statement-breakpoint
INSERT INTO "owner_outcomes" (
  "hive_id",
  "goal_id",
  "goal_completion_id",
  "summary",
  "why_it_matters",
  "impact_statement",
  "recommended_next_action",
  "evidence",
  "primary_work_product_id",
  "primary_open_url",
  "primary_artifact_title",
  "primary_artifact_render_mode",
  "route_metadata",
  "created_at",
  "updated_at"
)
SELECT
  g."hive_id",
  gc."goal_id",
  gc."id",
  gc."summary",
  'This creates a durable owner-visible handoff so final outcomes are reviewed separately from task artifacts and audit logs.',
  CASE h."kind"
    WHEN 'business' THEN 'Business hive impact: completed work is now an owner-visible handoff with review state.'
    WHEN 'personal_project' THEN 'Project hive impact: completed work has a shippable result ready for owner review.'
    WHEN 'personal_assistant' THEN 'Personal assistant impact: completed work is packaged so the owner can act or ask for revision.'
    WHEN 'research' THEN 'Research hive impact: completed findings are ready for owner review and next-step selection.'
    WHEN 'creative' THEN 'Creative hive impact: the finished asset is ready for owner inspection.'
    ELSE 'Hive impact: completed work is ready for owner review.'
  END,
  CASE
    WHEN primary_wp."open_url" IS NOT NULL THEN 'Review the primary work product, then accept it or request a bounded revision.'
    ELSE 'Review the goal handoff and linked evidence, then accept it or request a bounded revision.'
  END,
  gc."evidence",
  primary_wp."id",
  primary_wp."open_url",
  primary_wp."title",
  primary_wp."render_mode",
  jsonb_build_object(
    'source', 'goal_completion_backfill',
    'createdFromGoalCompletionId', gc."id"
  ),
  gc."created_at",
  NOW()
FROM "goal_completions" gc
JOIN "goals" g ON g."id" = gc."goal_id"
JOIN "hives" h ON h."id" = g."hive_id"
LEFT JOIN LATERAL (
  SELECT
    wp."id",
    COALESCE(NULLIF(BTRIM(wp."title"), ''), NULLIF(BTRIM(wp."filename"), ''), 'Deliverable') AS "title",
    wp."render_mode",
    CASE
      WHEN wp."public_url" ~* '^https?://' THEN wp."public_url"
      ELSE '/deliverables/' || wp."id"::text || '/open'
    END AS "open_url"
  FROM jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(gc."evidence"->'workProductIds') = 'array' THEN gc."evidence"->'workProductIds'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS evidence_ids(id, ord)
  JOIN "work_products" wp ON wp."id"::text = evidence_ids.id
  WHERE wp."hive_id" = g."hive_id"
    AND EXISTS (
      SELECT 1
      FROM "tasks" t
      WHERE t."id" = wp."task_id"
        AND t."goal_id" = gc."goal_id"
    )
  ORDER BY
    CASE
      WHEN wp."artifact_kind" = 'final_artifact' THEN 0
      WHEN COALESCE(wp."title", wp."filename", wp."file_path", '') ~* '(qa|review|compliance|signoff|audit|rework|notes|checklist|report)' THEN 2
      ELSE 1
    END,
    CASE wp."render_mode"
      WHEN 'external_url' THEN 0
      WHEN 'html' THEN 1
      WHEN 'image' THEN 2
      WHEN 'markdown' THEN 3
      WHEN 'text' THEN 4
      WHEN 'json' THEN 5
      ELSE 6
    END,
    evidence_ids.ord
  LIMIT 1
) primary_wp ON true
ON CONFLICT ("goal_completion_id") DO NOTHING;
