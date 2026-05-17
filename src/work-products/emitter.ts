import * as path from "node:path";
import * as fs from "node:fs";
import type { Sql } from "postgres";
import { assertPathInTaskImageDirectory } from "./image-storage";
import { classifySensitivity } from "./sensitivity";
import type { UsageDetails } from "@/usage/billable-usage";

export interface WorkProductInput {
  taskId: string;
  hiveId: string;
  roleSlug: string;
  department: string | null;
  content: string;
  summary: string | null;
  title?: string | null;
  filename?: string | null;
  artifactKind?: string | null;
  mimeType?: string | null;
  renderMode?: string | null;
  reviewStatus?: "ready" | "needs_review" | "approved" | "rejected" | "archived" | null;
  publicUrl?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  usageDetails?: UsageDetails | null;
}

export interface BinaryWorkProductInput extends WorkProductInput {
  filePath: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  modelName?: string | null;
  modelSnapshot?: string | null;
  promptTokens?: number | null;
  outputTokens?: number | null;
  costCents?: number | null;
  metadata?: Record<string, unknown> | null;
  usageDetails?: UsageDetails | null;
}

export function shouldEmitWorkProduct(taskTitle: string): boolean {
  if (taskTitle.startsWith("Result:")) return false;
  if (taskTitle.startsWith("ESCALATION:")) return false;
  if (taskTitle.startsWith("[Doctor]")) return false;
  return true;
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathInHiveWorkspace(filePath: string, hiveWorkspacePath: string): string {
  const workspace = path.resolve(hiveWorkspacePath);
  const resolved = path.resolve(filePath);
  if (!isPathInside(resolved, workspace)) {
    throw new Error("Work product file path escaped hive workspace");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error("Work product file path is not a file");
  }
  return resolved;
}

export async function emitWorkProduct(sql: Sql, input: WorkProductInput) {
  const sensitivity = classifySensitivity(input.content);
  const metadata = input.metadata ? sql.json(input.metadata as Parameters<typeof sql.json>[0]) : null;
  const usageDetails = input.usageDetails ? sql.json(input.usageDetails as unknown as Parameters<typeof sql.json>[0]) : null;

  const [wp] = await sql`
    INSERT INTO work_products (
      task_id, hive_id, role_slug, department, content, summary,
      title, filename, artifact_kind, mime_type, render_mode, review_status,
      public_url, source_url, metadata, sensitivity, usage_details
    )
    VALUES (
      ${input.taskId},
      ${input.hiveId},
      ${input.roleSlug},
      ${input.department},
      ${input.content},
      ${input.summary},
      ${input.title ?? null},
      ${input.filename ?? null},
      ${input.artifactKind ?? null},
      ${input.mimeType ?? null},
      ${input.renderMode ?? null},
      ${input.reviewStatus ?? "ready"},
      ${input.publicUrl ?? null},
      ${input.sourceUrl ?? null},
      ${metadata},
      ${sensitivity},
      ${usageDetails}
    )
    RETURNING *
  `;

  return wp;
}

export async function emitBinaryWorkProduct(sql: Sql, input: BinaryWorkProductInput) {
  const sensitivity = classifySensitivity(input.content);
  const metadata = input.metadata ? sql.json(input.metadata as Parameters<typeof sql.json>[0]) : null;
  const usageDetails = input.usageDetails ? sql.json(input.usageDetails as unknown as Parameters<typeof sql.json>[0]) : null;

  const [scope] = await sql`
    SELECT h.workspace_path
    FROM tasks t
    JOIN hives h ON h.id = t.hive_id
    WHERE t.id = ${input.taskId}
      AND t.hive_id = ${input.hiveId}
    LIMIT 1
  `;
  const hiveWorkspacePath = scope?.workspace_path as string | null | undefined;
  if (!hiveWorkspacePath) {
    throw new Error("Cannot emit file-backed work product without a hive workspace path");
  }
  const filePath = input.artifactKind === "image"
    ? assertPathInTaskImageDirectory({
        filePath: input.filePath,
        hiveWorkspacePath,
        taskId: input.taskId,
      })
    : assertPathInHiveWorkspace(input.filePath, hiveWorkspacePath);

  const [wp] = await sql`
    INSERT INTO work_products (
      task_id, hive_id, role_slug, department, content, summary,
      title, filename, artifact_kind, file_path, mime_type, render_mode, review_status,
      public_url, source_url, width, height, model_name, model_snapshot,
      prompt_tokens, output_tokens, cost_cents, metadata, sensitivity, usage_details
    )
    VALUES (
      ${input.taskId},
      ${input.hiveId},
      ${input.roleSlug},
      ${input.department},
      ${input.content},
      ${input.summary},
      ${input.title ?? null},
      ${input.filename ?? path.basename(filePath)},
      ${input.artifactKind ?? "file"},
      ${filePath},
      ${input.mimeType},
      ${input.renderMode ?? null},
      ${input.reviewStatus ?? "ready"},
      ${input.publicUrl ?? null},
      ${input.sourceUrl ?? null},
      ${input.width ?? null},
      ${input.height ?? null},
      ${input.modelName ?? null},
      ${input.modelSnapshot ?? null},
      ${input.promptTokens ?? null},
      ${input.outputTokens ?? null},
      ${input.costCents ?? null},
      ${metadata},
      ${sensitivity},
      ${usageDetails}
    )
    RETURNING *
  `;

  return wp;
}
