import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inferRenderMode } from "../deliverables/render-mode";
import type { DeliverableRenderMode } from "../deliverables/types";

export type ManifestDeliverableKind = "file" | "html" | "markdown" | "image" | "external_url";

export interface ManifestDeliverable {
  kind: ManifestDeliverableKind;
  path?: string;
  url?: string;
  mimeType?: string | null;
  title?: string | null;
  summary?: string | null;
  reviewRequired?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface LoadedManifestDeliverable {
  kind: ManifestDeliverableKind;
  path: string | null;
  publicUrl: string | null;
  mimeType: string | null;
  title: string | null;
  summary: string | null;
  reviewRequired: boolean;
  metadata: Record<string, unknown> | null;
  renderMode: DeliverableRenderMode;
  filename: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveContainedFile(workspace: string, candidatePath: string): Promise<string> {
  const candidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workspace, candidatePath);
  const [realWorkspace, realCandidate] = await Promise.all([
    fs.realpath(workspace),
    fs.realpath(candidate),
  ]);
  if (!isPathInside(realCandidate, realWorkspace)) {
    throw new Error(`Deliverable path escapes hive workspace: ${candidatePath}`);
  }
  const stat = await fs.stat(realCandidate);
  if (!stat.isFile()) {
    throw new Error(`Deliverable path is not a file: ${candidatePath}`);
  }
  return realCandidate;
}

function normalizeMimeType(kind: ManifestDeliverableKind, mimeType: unknown, filePath: string | null): string | null {
  if (typeof mimeType === "string" && mimeType.trim()) return mimeType.trim();
  if (!filePath) return kind === "external_url" ? "text/uri-list" : null;
  const ext = path.extname(filePath).toLowerCase();
  if (kind === "html" || ext === ".html" || ext === ".htm") return "text/html";
  if (kind === "markdown" || ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".json") return "application/json";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".txt") return "text/plain";
  return null;
}

function kindToRenderMode(kind: ManifestDeliverableKind, mimeType: string | null, filePath: string | null): DeliverableRenderMode {
  if (kind === "external_url") return "external_url";
  if (kind === "html") return "html";
  if (kind === "markdown") return "markdown";
  if (kind === "image") return "image";
  return inferRenderMode(mimeType, filePath, kind);
}

function normalizeEntry(entry: unknown): ManifestDeliverable | null {
  if (!isRecord(entry)) return null;
  const kind = entry.kind;
  if (kind !== "file" && kind !== "html" && kind !== "markdown" && kind !== "image" && kind !== "external_url") {
    return null;
  }
  const metadata = isRecord(entry.metadata) ? entry.metadata : null;
  return {
    kind,
    path: typeof entry.path === "string" ? entry.path : undefined,
    url: typeof entry.url === "string" ? entry.url : undefined,
    mimeType: typeof entry.mimeType === "string" ? entry.mimeType : null,
    title: typeof entry.title === "string" ? entry.title : null,
    summary: typeof entry.summary === "string" ? entry.summary : null,
    reviewRequired: entry.reviewRequired === true,
    metadata,
  };
}

export async function loadDeliverableManifest(options: {
  hiveWorkspacePath: string | null | undefined;
  taskId: string;
}): Promise<LoadedManifestDeliverable[]> {
  const workspacePath = options.hiveWorkspacePath;
  if (!workspacePath) return [];
  const workspace = path.resolve(workspacePath);
  const manifestCandidates = [
    path.join(workspace, ".hivewright", "deliverables", options.taskId, "manifest.json"),
    path.join(workspace, "work-products", options.taskId, "manifest.json"),
  ];

  let manifestPath: string | null = null;
  for (const candidate of manifestCandidates) {
    try {
      const realCandidate = await resolveContainedFile(workspace, candidate);
      manifestPath = realCandidate;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
  if (!manifestPath) return [];

  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  const rawEntries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.deliverables)
      ? parsed.deliverables
      : [];

  const loaded: LoadedManifestDeliverable[] = [];
  for (const rawEntry of rawEntries) {
    const entry = normalizeEntry(rawEntry);
    if (!entry) continue;

    let resolvedPath: string | null = null;
    let publicUrl: string | null = null;
    if (entry.kind === "external_url") {
      publicUrl = entry.url ?? entry.path ?? null;
      if (!publicUrl) continue;
    } else {
      if (!entry.path) continue;
      resolvedPath = await resolveContainedFile(workspace, entry.path);
    }

    const mimeType = normalizeMimeType(entry.kind, entry.mimeType, resolvedPath ?? entry.path ?? null);
    const renderMode = kindToRenderMode(entry.kind, mimeType, resolvedPath ?? entry.path ?? null);
    loaded.push({
      kind: entry.kind,
      path: resolvedPath,
      publicUrl,
      mimeType,
      title: entry.title ?? null,
      summary: entry.summary ?? null,
      reviewRequired: entry.reviewRequired ?? false,
      metadata: entry.metadata ?? null,
      renderMode,
      filename: resolvedPath ? path.basename(resolvedPath) : null,
    });
  }
  return loaded;
}
