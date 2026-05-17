import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Sql } from "postgres";
import type { CompletionEvidenceItem } from "./completion";

type EvidenceRecord = {
  taskIds?: string[];
  workProductIds?: string[];
  bundle?: CompletionEvidenceItem[];
};

type FinalArtifactContext = {
  goalId: string;
  hiveId: string;
  goalTitle: string;
  evidence: EvidenceRecord;
};

type GoalTaskRow = {
  id: string;
  assigned_to: string;
};

type HiveWorkspaceRow = {
  slug: string;
  workspace_path: string | null;
};

type InsertedWorkProductRow = {
  id: string;
};

type Candidate = {
  item: CompletionEvidenceItem;
  absolutePath: string;
  realPath: string;
  workspaceRoot: string;
  filename: string;
  extension: string;
};

const FINAL_ARTIFACT_EXTENSIONS = new Set([".html", ".htm"]);
const REVIEW_PROVENANCE_WORDS = /\b(qa|review|compliance|signoff|audit|rework|notes?|checklist|report)\b/i;
const WEB_PAGE_GOAL_WORDS = /\b(landing\s+page|website|web\s?page|homepage|microsite)\b/i;

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isVerifiedArtifact(item: CompletionEvidenceItem): boolean {
  if (item.verified !== true) return false;
  if (!item.reference) return false;
  return /artifact|deliverable|output|page|file/i.test(item.type);
}

function candidateScore(candidate: Candidate): number {
  const haystack = `${candidate.filename} ${candidate.absolutePath} ${candidate.item.description}`;
  let score = 0;
  if (candidate.extension === ".html" || candidate.extension === ".htm") score += 100;
  if (/index\.html?$/i.test(candidate.filename)) score += 30;
  if (/landing[-_ ]?page/i.test(haystack)) score += 20;
  if (/final|shipped|output|deliverable|page|package/i.test(haystack)) score += 15;
  if (REVIEW_PROVENANCE_WORDS.test(haystack)) score -= 50;
  return score;
}

function humanizePathPart(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function titleForFinalArtifact(goalTitle: string, candidate: Pick<Candidate, "absolutePath" | "filename" | "item">): string {
  const source = `${goalTitle} ${candidate.item.description} ${candidate.absolutePath}`;
  const brandMatch = source.match(/\bhivewright\b/i);
  const brand = brandMatch ? "HiveWright" : null;
  const pathParts = candidate.absolutePath.split(path.sep).filter(Boolean);
  const meaningfulPart = pathParts
    .slice()
    .reverse()
    .find((part) => /landing[-_ ]?page|website|homepage|page/i.test(part));
  const artifactName = meaningfulPart ? humanizePathPart(meaningfulPart) : humanizePathPart(candidate.filename);
  if (brand && !new RegExp(`^${brand}\\b`, "i").test(artifactName)) return `${brand} ${artifactName}`;
  return artifactName || (brand ? `${brand} Final Output` : "Final Output");
}

function evidenceReferenceMatchesPath(item: CompletionEvidenceItem, expectedPath: string, workspaceRoot: string, htmlDir: string): boolean {
  if (item.verified !== true || !item.reference) return false;
  const reference = item.reference;
  const candidates = path.isAbsolute(reference)
    ? [path.resolve(reference)]
    : [path.resolve(workspaceRoot, reference), path.resolve(htmlDir, reference)];
  return candidates.some((candidate) => candidate === expectedPath);
}

async function buildHtmlContentWithInlineCss(htmlPath: string, workspaceRoot: string, html: string, bundle: CompletionEvidenceItem[]): Promise<string> {
  const htmlDir = path.dirname(htmlPath);
  const realWorkspaceRoot = await fs.realpath(workspaceRoot);
  const replacements: Array<[string, string]> = [];
  const links = Array.from(html.matchAll(/<link\b([^>]*?)>/gi));
  for (let index = 0; index < links.length; index += 1) {
    const match = links[index];
    const full = match[0];
    const attrs = match[1] ?? "";
    const relMatch = attrs.match(/\brel\s*=\s*(["'])stylesheet\1/i);
    const hrefMatch = attrs.match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
    if (!relMatch || !hrefMatch) continue;
    const href = hrefMatch[2];
    if (/^(?:https?:)?\/\//i.test(href) || href.startsWith("data:")) continue;
    const cssPath = path.resolve(htmlDir, href);
    if (!isPathInside(cssPath, workspaceRoot)) continue;
    const cssRef = bundle.some((item) => evidenceReferenceMatchesPath(item, cssPath, workspaceRoot, htmlDir));
    if (!cssRef) continue;
    try {
      const realCssPath = await fs.realpath(cssPath);
      if (!isPathInside(realCssPath, realWorkspaceRoot)) continue;
      const css = await fs.readFile(realCssPath, "utf8");
      replacements.push([full, `<style data-hivewright-inlined-from=${JSON.stringify(href)}>\n${css}\n</style>`]);
    } catch {
      // Leave the original link in place if the sibling stylesheet cannot be read.
    }
  }

  let output = html;
  for (let index = 0; index < replacements.length; index += 1) {
    const [original, replacement] = replacements[index];
    output = output.replace(original, replacement);
  }
  return output;
}

async function existingWorkspaceRoots(roots: string[]): Promise<Array<{ root: string; realRoot: string }>> {
  const uniqueRoots = Array.from(new Set(roots.map((root) => path.resolve(root))));
  const existing: Array<{ root: string; realRoot: string }> = [];
  for (const root of uniqueRoots) {
    try {
      existing.push({ root, realRoot: await fs.realpath(root) });
    } catch {
      // Ignore stale configured workspaces; they cannot safely contain readable artifacts.
    }
  }
  return existing;
}

function resolveHiveRuntimeProjectsPath(slug: string): string {
  const runtimeRoot = process.env.HIVEWRIGHT_RUNTIME_ROOT || path.join(os.homedir(), ".hivewright");
  const hivesRoot = process.env.HIVES_WORKSPACE_ROOT || path.join(runtimeRoot, "hives");
  return path.join(hivesRoot, slug, "projects");
}

async function findBestBundleArtifact(workspaceRoots: string[], bundle: CompletionEvidenceItem[]): Promise<Candidate | null> {
  const roots = await existingWorkspaceRoots(workspaceRoots);
  if (roots.length === 0) return null;

  const candidates: Candidate[] = [];
  for (const item of bundle) {
    if (!isVerifiedArtifact(item)) continue;
    const reference = item.reference as string;
    const extension = path.extname(reference).toLowerCase();
    if (!FINAL_ARTIFACT_EXTENSIONS.has(extension)) continue;

    const possiblePaths = path.isAbsolute(reference)
      ? [path.resolve(reference)]
      : roots.map(({ root }) => path.resolve(root, reference));

    for (const absolutePath of possiblePaths) {
      const containingRoot = roots.find(({ root }) => isPathInside(absolutePath, root));
      if (!containingRoot) continue;
      try {
        const realPath = await fs.realpath(absolutePath);
        if (!isPathInside(realPath, containingRoot.realRoot)) continue;
        const stat = await fs.stat(realPath);
        if (!stat.isFile()) continue;
        candidates.push({
          item,
          absolutePath,
          realPath,
          workspaceRoot: containingRoot.root,
          filename: path.basename(realPath),
          extension: path.extname(realPath).toLowerCase(),
        });
      } catch {
        continue;
      }
    }
  }

  candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
  return candidates[0] ?? null;
}

async function chooseTask(sql: Sql, context: FinalArtifactContext): Promise<GoalTaskRow | null> {
  const existingIds = context.evidence.workProductIds?.filter((id) => id.trim().length > 0) ?? [];
  if (existingIds.length > 0) {
    const rows = await sql<GoalTaskRow[]>`
      SELECT wp.task_id AS id, t.assigned_to
      FROM work_products wp
      JOIN tasks t ON t.id = wp.task_id
      WHERE wp.id = ANY(${existingIds}::uuid[])
        AND wp.hive_id = ${context.hiveId}
        AND t.goal_id = ${context.goalId}
      ORDER BY array_position(${existingIds}::uuid[], wp.id)
      LIMIT 1
    `;
    if (rows[0]?.id) return rows[0];
  }

  const evidenceTaskIds = context.evidence.taskIds?.filter((id) => id.trim().length > 0) ?? [];
  if (evidenceTaskIds.length > 0) {
    const rows = await sql<GoalTaskRow[]>`
      SELECT id, assigned_to
      FROM tasks
      WHERE id = ANY(${evidenceTaskIds}::uuid[])
        AND hive_id = ${context.hiveId}
        AND goal_id = ${context.goalId}
      ORDER BY array_position(${evidenceTaskIds}::uuid[], id)
      LIMIT 1
    `;
    if (rows[0]?.id) return rows[0];
  }

  const rows = await sql<GoalTaskRow[]>`
    SELECT id, assigned_to
    FROM tasks
    WHERE hive_id = ${context.hiveId}
      AND goal_id = ${context.goalId}
    ORDER BY
      CASE status WHEN 'completed' THEN 0 ELSE 1 END,
      updated_at DESC NULLS LAST,
      created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export function goalRequiresOwnerOpenableWebArtifact(goalTitle: string): boolean {
  return WEB_PAGE_GOAL_WORDS.test(goalTitle);
}

async function hasOwnerOpenableWebArtifact(sql: Sql, context: FinalArtifactContext): Promise<boolean> {
  const ids = context.evidence.workProductIds?.filter((id) => id.trim().length > 0) ?? [];
  if (ids.length === 0) return false;
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM work_products
    WHERE id = ANY(${ids}::uuid[])
      AND hive_id = ${context.hiveId}
      AND (
        render_mode IN ('html', 'external_url')
        OR mime_type ILIKE 'text/html%'
        OR public_url ~* '^https?://'
      )
      AND NOT (COALESCE(title, filename, file_path, summary, '') ~* '(qa|review|compliance|signoff|audit|rework|notes|checklist)')
  `;
  return (rows[0]?.count ?? 0) > 0;
}

export async function assertRequiredFinalArtifactsAvailable(sql: Sql, context: FinalArtifactContext): Promise<void> {
  if (!goalRequiresOwnerOpenableWebArtifact(context.goalTitle)) return;
  if (await hasOwnerOpenableWebArtifact(sql, context)) return;
  throw new Error(
    "Goal completion blocked: this looks like a web/landing-page goal, but no owner-openable HTML or URL final artifact is registered. Register the actual page as a final work product or include a verified evidence bundle reference to the generated index.html before marking the goal achieved.",
  );
}

export async function normalizeFinalArtifactsFromEvidenceBundle(sql: Sql, context: FinalArtifactContext): Promise<string[]> {
  const bundle = context.evidence.bundle ?? [];
  if (bundle.length === 0) return [];

  const [workspaceRow] = await sql<HiveWorkspaceRow[]>`
    SELECT slug, workspace_path
    FROM hives
    WHERE id = ${context.hiveId}
    LIMIT 1
  `;
  if (!workspaceRow?.slug && !workspaceRow?.workspace_path) return [];
  const workspaceRoots = [
    ...(workspaceRow.workspace_path ? [workspaceRow.workspace_path] : []),
    ...(workspaceRow.slug ? [resolveHiveRuntimeProjectsPath(workspaceRow.slug)] : []),
  ];

  const candidate = await findBestBundleArtifact(workspaceRoots, bundle);
  if (!candidate) return [];

  const task = await chooseTask(sql, context);
  if (!task) return [];

  const html = await fs.readFile(candidate.realPath, "utf8");
  const content = await buildHtmlContentWithInlineCss(candidate.realPath, candidate.workspaceRoot, html, bundle);
  const metadata = {
    source: "goal_completion_evidence_bundle",
    sourceReference: candidate.item.reference,
    sourcePath: path.relative(path.resolve(candidate.workspaceRoot), candidate.realPath),
    normalizedAt: new Date().toISOString(),
  };
  const title = titleForFinalArtifact(context.goalTitle, candidate);

  const [wp] = await sql<InsertedWorkProductRow[]>`
    INSERT INTO work_products (
      task_id, hive_id, role_slug, department, content, summary,
      title, filename, artifact_kind, file_path, mime_type, render_mode, review_status,
      metadata, sensitivity
    )
    VALUES (
      ${task.id},
      ${context.hiveId},
      ${task.assigned_to},
      NULL,
      ${content},
      ${candidate.item.description},
      ${title},
      ${candidate.filename},
      'final_artifact',
      NULL,
      'text/html; charset=utf-8',
      'html',
      'ready',
      ${sql.json(metadata as Parameters<typeof sql.json>[0])},
      'internal'
    )
    RETURNING id
  `;

  if (!wp?.id) return [];
  const existing = context.evidence.workProductIds ?? [];
  context.evidence.workProductIds = [wp.id, ...existing.filter((id) => id !== wp.id)];
  return [wp.id];
}
