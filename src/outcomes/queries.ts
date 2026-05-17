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
    status: "unread",
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
      gc.id,
      gc.goal_id,
      gc.summary,
      gc.evidence,
      gc.created_at,
      g.hive_id,
      g.title AS goal_title,
      primary_wp.id AS primary_work_product_id,
      primary_wp.open_url AS primary_open_url,
      primary_wp.title AS primary_artifact_title,
      primary_wp.render_mode AS primary_artifact_render_mode
    FROM goal_completions gc
    JOIN goals g ON g.id = gc.goal_id
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
          WHEN jsonb_typeof(gc.evidence->'workProductIds') = 'array' THEN gc.evidence->'workProductIds'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS evidence_ids(id, ord)
      JOIN work_products wp ON wp.id::text = evidence_ids.id
      WHERE wp.hive_id = g.hive_id
        AND EXISTS (
          SELECT 1
          FROM tasks t
          WHERE t.id = wp.task_id
            AND t.goal_id = gc.goal_id
        )
      ORDER BY
        CASE
          WHEN wp.artifact_kind = 'final_artifact' THEN 0
          WHEN COALESCE(wp.title, wp.filename, wp.file_path, '') ~* '(qa|review|compliance|signoff|audit|rework|notes|checklist|report)' THEN 2
          ELSE 1
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
    WHERE (${filters.hiveId ?? null}::uuid IS NULL OR g.hive_id = ${filters.hiveId ?? null})
    ORDER BY gc.created_at DESC
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
    FROM goal_completions gc
    JOIN goals g ON g.id = gc.goal_id
    WHERE (${filters.hiveId ?? null}::uuid IS NULL OR g.hive_id = ${filters.hiveId ?? null})
  ` as Array<{ count: number | string }>;
  return Number(row?.count ?? 0);
}
