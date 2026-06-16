import * as path from "node:path";
import { inferRenderMode } from "./render-mode";
import type { DeliverableRenderMode, DeliverableReviewStatus, DeliverableSummary } from "./types";

type SqlExecutor = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export type DeliverableRow = {
  id: string;
  hive_id: string;
  task_id: string;
  goal_id: string | null;
  title: string | null;
  summary: string | null;
  filename: string | null;
  mime_type: string | null;
  render_mode: string | null;
  review_status: string | null;
  public_url: string | null;
  source_url: string | null;
  content: string | null;
  artifact_kind: string | null;
  file_path: string | null;
  source_task_title: string | null;
  source_goal_title: string | null;
  created_at: Date | string;
  workspace_path?: string | null;
};

export type DeliverableDetail = DeliverableSummary & {
  content: string | null;
  filePath: string | null;
  artifactKind: string | null;
  publicUrl: string | null;
  sourceUrl: string | null;
  workspacePath: string | null;
};

const REVIEW_STATUSES = new Set<DeliverableReviewStatus>([
  "ready",
  "needs_review",
  "approved",
  "rejected",
  "archived",
]);

function firstSummaryLine(summary: string | null): string | null {
  const line = summary?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  return line || null;
}

export function slugifyFilenameStem(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "deliverable";
}

export function fallbackTitle(row: Pick<DeliverableRow, "id" | "title" | "summary" | "source_task_title" | "filename" | "file_path">): string {
  return row.title?.trim()
    || firstSummaryLine(row.summary)
    || row.source_task_title?.trim()
    || row.filename?.trim()
    || (row.file_path ? path.basename(row.file_path) : null)
    || `work-product-${row.id}`;
}

export function fallbackFilename(row: Pick<DeliverableRow, "filename" | "file_path" | "title" | "summary" | "source_task_title" | "id">): string {
  const explicit = row.filename?.trim();
  if (explicit) return path.basename(explicit);
  if (row.file_path) return path.basename(row.file_path);
  return `${slugifyFilenameStem(fallbackTitle(row))}.md`;
}

function normalizeReviewStatus(value: string | null): DeliverableReviewStatus {
  return REVIEW_STATUSES.has(value as DeliverableReviewStatus) ? value as DeliverableReviewStatus : "ready";
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function normalizeRenderMode(row: DeliverableRow, filename: string): DeliverableRenderMode {
  const explicit = row.render_mode as DeliverableRenderMode | null;
  if (explicit && ["text", "markdown", "html", "image", "json", "file", "external_url"].includes(explicit)) {
    return explicit;
  }
  if (row.public_url && !row.file_path && !row.content) return "external_url";
  return inferRenderMode(row.mime_type, filename || row.file_path, row.artifact_kind);
}

function internalDeliverableUrl(row: Pick<DeliverableRow, "id" | "hive_id">, action: "content" | "download"): string {
  return `/api/deliverables/${encodeURIComponent(row.id)}/${action}?hiveId=${encodeURIComponent(row.hive_id)}`;
}

export function mapDeliverableRow(row: DeliverableRow): DeliverableDetail {
  const title = fallbackTitle(row);
  const filename = fallbackFilename({ ...row, title });
  const renderMode = normalizeRenderMode(row, filename);
  const openUrl = renderMode === "external_url" && row.public_url
    ? row.public_url
    : internalDeliverableUrl(row, "content");
  const downloadUrl = renderMode === "external_url" ? null : internalDeliverableUrl(row, "download");

  return {
    id: row.id,
    hiveId: row.hive_id,
    taskId: row.task_id,
    goalId: row.goal_id,
    title,
    summary: row.summary,
    filename,
    mimeType: row.mime_type,
    renderMode,
    reviewStatus: normalizeReviewStatus(row.review_status),
    openUrl,
    downloadUrl,
    sourceTaskTitle: row.source_task_title,
    sourceGoalTitle: row.source_goal_title,
    createdAt: toIso(row.created_at),
    content: row.content,
    filePath: row.file_path,
    artifactKind: row.artifact_kind,
    publicUrl: row.public_url,
    sourceUrl: row.source_url,
    workspacePath: row.workspace_path ?? null,
  };
}

export function toDeliverableSummary(detail: DeliverableDetail): DeliverableSummary {
  return {
    id: detail.id,
    hiveId: detail.hiveId,
    taskId: detail.taskId,
    goalId: detail.goalId,
    title: detail.title,
    summary: detail.summary,
    filename: detail.filename,
    mimeType: detail.mimeType,
    renderMode: detail.renderMode,
    reviewStatus: detail.reviewStatus,
    openUrl: detail.openUrl,
    downloadUrl: detail.downloadUrl,
    sourceTaskTitle: detail.sourceTaskTitle,
    sourceGoalTitle: detail.sourceGoalTitle,
    createdAt: detail.createdAt,
  };
}

export async function listDeliverables(sql: SqlExecutor, filters: { hiveId?: string | null; taskId?: string | null; goalId?: string | null; completedOnly?: boolean } = {}): Promise<DeliverableSummary[]> {
  const rows = await sql`
    SELECT
      wp.id,
      wp.hive_id,
      wp.task_id,
      t.goal_id,
      wp.title,
      wp.summary,
      wp.filename,
      wp.mime_type,
      wp.render_mode,
      wp.review_status,
      wp.public_url,
      wp.source_url,
      wp.content,
      wp.artifact_kind,
      wp.file_path,
      t.title AS source_task_title,
      g.title AS source_goal_title,
      wp.created_at
    FROM work_products wp
    JOIN tasks t ON t.id = wp.task_id
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE (${filters.hiveId ?? null}::uuid IS NULL OR wp.hive_id = ${filters.hiveId ?? null})
      AND (${filters.taskId ?? null}::uuid IS NULL OR wp.task_id = ${filters.taskId ?? null})
      AND (${filters.goalId ?? null}::uuid IS NULL OR t.goal_id = ${filters.goalId ?? null})
      AND (${filters.completedOnly ? "completed" : null}::text IS NULL OR t.status = ${filters.completedOnly ? "completed" : null})
    ORDER BY
      CASE
        WHEN wp.artifact_kind = 'final_artifact' THEN 0
        WHEN CONCAT_WS(
          ' ',
          wp.title,
          wp.filename,
          wp.file_path,
          wp.artifact_kind,
          t.assigned_to,
          t.created_by
        ) ~* '(qa|review|compliance|signoff|audit|rework|notes|checklist|doctor|supervisor|peer[- ]?review)' THEN 7
        WHEN wp.artifact_kind = 'landing_page' THEN 1
        WHEN wp.artifact_kind = 'image' THEN 2
        WHEN wp.artifact_kind = 'document' THEN 3
        WHEN wp.artifact_kind = 'report' THEN 4
        WHEN wp.artifact_kind IN ('business_output', 'deliverable', 'asset', 'publication') THEN 5
        ELSE 6
      END,
      wp.created_at DESC
    LIMIT 200
  `;
  return (rows as DeliverableRow[]).map((row) => toDeliverableSummary(mapDeliverableRow(row)));
}

export async function getDeliverable(sql: SqlExecutor, id: string): Promise<DeliverableDetail | null> {
  const rows = await sql`
    SELECT
      wp.id,
      wp.hive_id,
      wp.task_id,
      t.goal_id,
      wp.title,
      wp.summary,
      wp.filename,
      wp.mime_type,
      wp.render_mode,
      wp.review_status,
      wp.public_url,
      wp.source_url,
      wp.content,
      wp.artifact_kind,
      wp.file_path,
      t.title AS source_task_title,
      g.title AS source_goal_title,
      wp.created_at,
      h.workspace_path
    FROM work_products wp
    JOIN hives h ON h.id = wp.hive_id
    JOIN tasks t ON t.id = wp.task_id
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE wp.id = ${id}
    LIMIT 1
  `;
  const deliverableRows = rows as DeliverableRow[];
  if (deliverableRows.length === 0) return null;
  return mapDeliverableRow(deliverableRows[0]);
}
