import type { OwnerOutcomeRenderMode, OwnerOutcomeSummary } from "./types";

type SqlExecutor = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

const RENDER_MODES = new Set<OwnerOutcomeRenderMode>([
  "text",
  "markdown",
  "html",
  "image",
  "json",
  "file",
  "external_url",
]);

export type OwnerOutcomeRow = {
  id: string;
  goal_id: string;
  hive_id: string;
  goal_title: string;
  summary: string | null;
  why_it_matters: string | null;
  recommended_next_action: string | null;
  impact_statement: string | null;
  review_state: string;
  evidence: unknown;
  primary_work_product_id: string | null;
  primary_open_url: string | null;
  primary_artifact_title: string | null;
  primary_artifact_render_mode: string | null;
  created_at: Date | string;
};

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function parseEvidenceWorkProductIds(evidence: unknown): string[] {
  if (!evidence || typeof evidence !== "object") return [];
  const raw = (evidence as { workProductIds?: unknown }).workProductIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function normalizeRenderMode(value: string | null): OwnerOutcomeRenderMode | null {
  return RENDER_MODES.has(value as OwnerOutcomeRenderMode) ? value as OwnerOutcomeRenderMode : null;
}

function normalizeStatus(value: string): OwnerOutcomeSummary["status"] {
  switch (value) {
    case "accepted":
    case "needs_revision":
    case "archived":
    case "converted_to_process_candidate":
      return value;
    default:
      return "new";
  }
}

export function ownerOutcomeActionLabel(renderMode: OwnerOutcomeRenderMode | null, openUrl: string | null): string {
  if (!openUrl) return "Review final output";
  if (/^https?:\/\//i.test(openUrl)) return "Open live page";
  switch (renderMode) {
    case "html":
      return "View output page";
    case "image":
      return "View image";
    case "markdown":
    case "text":
    case "json":
      return "Read output";
    case "file":
      return "Open file";
    case "external_url":
      return "Open live page";
    default:
      return "View output";
  }
}

export function mapOwnerOutcomeRow(row: OwnerOutcomeRow): OwnerOutcomeSummary {
  const evidenceWorkProductIds = parseEvidenceWorkProductIds(row.evidence);
  const primaryWorkProductId = row.primary_work_product_id ?? evidenceWorkProductIds[0] ?? null;
  const primaryDetailUrl = row.primary_work_product_id ? `/deliverables/${row.primary_work_product_id}` : null;
  const renderMode = normalizeRenderMode(row.primary_artifact_render_mode);

  return {
    id: row.id,
    goalId: row.goal_id,
    hiveId: row.hive_id,
    goalTitle: row.goal_title,
    summary: row.summary?.trim() || "Goal completed. Review the final owner handoff and linked audit evidence.",
    whyItMatters: row.why_it_matters?.trim() || "This durable handoff separates the owner outcome from lower-level task artifacts.",
    recommendedNextAction: row.recommended_next_action?.trim() || "Review the handoff and accept it, request revision, archive it, or mark it as a process candidate.",
    impactStatement: row.impact_statement?.trim() || "Hive impact: completed work is ready for owner review.",
    status: normalizeStatus(row.review_state),
    createdAt: toIso(row.created_at),
    evidenceWorkProductIds,
    primaryWorkProductId,
    primaryOpenUrl: row.primary_open_url,
    primaryDetailUrl,
    primaryArtifactTitle: row.primary_artifact_title?.trim() || null,
    primaryArtifactRenderMode: renderMode,
    primaryActionLabel: ownerOutcomeActionLabel(renderMode, row.primary_open_url),
  };
}

export async function listOwnerOutcomes(
  sql: SqlExecutor,
  filters: { hiveId?: string | null; limit?: number } = {},
): Promise<OwnerOutcomeSummary[]> {
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 100);
  const rows = await sql`
    SELECT
      oo.id,
      oo.goal_id,
      oo.summary,
      oo.why_it_matters,
      oo.recommended_next_action,
      oo.impact_statement,
      oo.review_state,
      oo.evidence,
      oo.created_at,
      oo.hive_id,
      g.title AS goal_title,
      COALESCE(stored_wp.id, primary_wp.id) AS primary_work_product_id,
      COALESCE(oo.primary_open_url, stored_wp.open_url, primary_wp.open_url) AS primary_open_url,
      COALESCE(oo.primary_artifact_title, stored_wp.title, primary_wp.title) AS primary_artifact_title,
      COALESCE(oo.primary_artifact_render_mode, stored_wp.render_mode, primary_wp.render_mode) AS primary_artifact_render_mode
    FROM owner_outcomes oo
    JOIN goals g ON g.id = oo.goal_id
    JOIN goal_completions gc ON gc.id = oo.goal_completion_id
    LEFT JOIN LATERAL (
      SELECT
        wp.id,
        COALESCE(NULLIF(BTRIM(wp.title), ''), NULLIF(BTRIM(wp.filename), ''), 'Deliverable') AS title,
        wp.render_mode,
        CASE
          WHEN wp.public_url ~* '^https?://' THEN wp.public_url
          ELSE '/deliverables/' || wp.id::text || '/open'
        END AS open_url
      FROM work_products wp
      WHERE wp.id = oo.primary_work_product_id
        AND wp.hive_id = oo.hive_id
      LIMIT 1
    ) stored_wp ON true
    LEFT JOIN LATERAL (
      SELECT
        wp.id,
        COALESCE(NULLIF(BTRIM(wp.title), ''), NULLIF(BTRIM(wp.filename), ''), 'Deliverable') AS title,
        wp.render_mode,
        CASE
          WHEN wp.public_url ~* '^https?://' THEN wp.public_url
          ELSE '/deliverables/' || wp.id::text || '/open'
        END AS open_url
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(oo.evidence->'workProductIds') = 'array' THEN oo.evidence->'workProductIds'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS evidence_ids(id, ord)
      JOIN work_products wp ON wp.id::text = evidence_ids.id
      JOIN tasks source_task ON source_task.id = wp.task_id
      WHERE wp.hive_id = oo.hive_id
        AND source_task.goal_id = oo.goal_id
      ORDER BY
        CASE
          WHEN wp.artifact_kind = 'final_artifact' THEN 0
          WHEN CONCAT_WS(
            ' ',
            wp.title,
            wp.filename,
            wp.file_path,
            wp.artifact_kind,
            source_task.assigned_to,
            source_task.created_by
          ) ~* '(qa|review|compliance|signoff|audit|rework|notes|checklist|doctor|supervisor|peer[- ]?review)' THEN 7
          WHEN wp.artifact_kind = 'landing_page' THEN 1
          WHEN wp.artifact_kind = 'image' THEN 2
          WHEN wp.artifact_kind = 'document' THEN 3
          WHEN wp.artifact_kind = 'report' THEN 4
          WHEN wp.artifact_kind IN ('business_output', 'deliverable', 'asset', 'publication') THEN 5
          ELSE 6
        END,
        CASE wp.render_mode
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
    WHERE (${filters.hiveId ?? null}::uuid IS NULL OR oo.hive_id = ${filters.hiveId ?? null})
    ORDER BY oo.created_at DESC
    LIMIT ${limit}
  `;
  return (rows as OwnerOutcomeRow[]).map(mapOwnerOutcomeRow);
}

export async function countOwnerOutcomes(
  sql: SqlExecutor,
  filters: { hiveId?: string | null } = {},
): Promise<number> {
  const [row] = await sql`
    SELECT COUNT(*)::int AS count
    FROM owner_outcomes oo
    WHERE oo.review_state = 'new'
      AND (${filters.hiveId ?? null}::uuid IS NULL OR oo.hive_id = ${filters.hiveId ?? null})
  ` as Array<{ count: number | string }>;
  return Number(row?.count ?? 0);
}
