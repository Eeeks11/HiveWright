import fs from "fs";
import path from "path";
import type { SessionContext } from "../adapters/types";
import type { ClaimedTask } from "./types";

export type WorkspacePolicyDecision =
  | { allowed: true; reason: null; signals: string[] }
  | { allowed: false; reason: string; signals: string[] };

export interface WorkspacePolicyOptions {
  forbiddenRoots?: string[];
  operationalInstallRoot?: string | null;
  approvedCodeWorkspaceRoots?: string[];
  requireActiveIsolation?: boolean;
}

const DEFAULT_FORBIDDEN_ROOTS = [
  "/home/trent/hivewrightv2",
  "/home/trent/archive/legacy-ai-systems",
];

const DEFAULT_OPERATIONAL_INSTALL_ROOT = "/home/trent/apps/HiveWright";

const DEFAULT_APPROVED_CODE_WORKSPACE_ROOTS = [
  "/home/twhis/dev/hivewright",
  "/home/trent/dev/hivewright",
];

const CODE_ROLE_SLUGS = new Set([
  "dev-agent",
  "infrastructure-agent",
  "frontend-engineer",
  "backend-engineer",
  "software-engineer",
  "hive-development-agent",
  "code-review-agent",
  "qa-reviewer",
]);

const CODE_CHANGE_PATTERN = /\b(app|backend|bug|build|code(?!\s+word)|component|dashboard|dispatcher|fix|frontend|implementation|migration|patch|pull request|refactor|repo|source code|typescript|ui|ux|vitest)\b/i;
const PRODUCT_CODE_CHANGE_PATTERN = /\b(app|backend|bug|build|component|dashboard|dispatcher|fix|frontend|implementation|(?:database|db|schema|drizzle) migration|patch|pull request|refactor|repo|source code|typescript|ui|ux|vitest)\b/i;
const HIVEWRIGHT_PRODUCT_PATTERN = /\b(hivewright|dispatcher|dashboard|agent stream|task stream|hive page|hives?\/[\[:]|reference document.*(?:ui|ux|page|component)|runtime preflight)\b/i;
const READ_ONLY_NON_CODE_PATTERN = /\b(do not|don't|without)\b.{0,120}\b(edit|change|modify|patch|write|touch|run git commands|create branches|create worktrees|commit|require)\b.{0,120}\b(code|repo|repository|repositories|source|implementation|local development|git-backed project|project checkout|branch|worktree|commit)\b|\b(do not|don't)\b.{0,120}\b(spawn|create|perform|require)\b.{0,120}\b(implementation|code change|code-changing|git-backed project|project checkout|local filesystem artifact)\b|\b(repository-neutral|research and clarification only|bounded governance-disposition pass|bounded governance disposition pass)\b|\bdo not\b.{0,80}\bpropose\b.{0,80}\b(hivewright product improvements|internal platform work|ai model\/runtime changes)\b|\bread[- ]only\b.{0,80}\b(api|path|scan|summary|analysis|diagnosis|research|artifact|artifacts)\b/i;
const NON_CODE_RECOVERY_PATTERN = /\b(qa failure re-planning|replan|diagnosis only|follow-up task only|review the skill content|audit readiness|readiness artifact|readiness packet|backup|restore-smoke|evidence pack|inventory and recommendation|canonical inventory|owner approval gate memo|source task\/work-product references|retained artifact references|retained work products|current external signals|daily world scan)\b/i;
const COMPLIANCE_READ_ONLY_ARTIFACT_PATTERN = /\b(oaic|privacy|compliance|risk)\b.{0,160}\b(checklist\/table|checklist|finite table|internal artifacts|source references)\b|\b(checklist\/table|checklist|finite table|internal artifacts|source references)\b.{0,160}\b(oaic|privacy|compliance|risk)\b/i;
const EXPLICIT_NON_IMPLEMENTATION_PATTERN = /\b(do not|don't)\b.{0,120}\b(live probes|production\/?customer data|configuration changes|config changes|vendor contact|external-facing policy text)\b|\bmark it as unknown or defer\b|\bmitigation(?:s)?\b.{0,80}\b(internal-safe|implementation-later|owner-gated|defer)\b/i;
const QA_REVIEW_ONLY_PATTERN = /\b(review|evaluate|verify)\b.{0,120}\b(deliverable|artifact|acceptance criteria|pass|fail)\b|\bfirst non-empty line\b.{0,80}\b(pass|fail)\b/i;
const EXPLICIT_SOURCE_EDIT_PATTERN = /\b(patch|modify|edit|change|write|implement|refactor|fix)\b.{0,80}\b(source code|codebase|repository|repo|component|typescript|migration|schema|dispatcher-bundle|dashboard|api route|source implementation|implementation source)\b|\b(add|update)\b.{0,80}\b(test|vitest|migration|schema|component|route)\b/i;
const POSITIVE_SOURCE_EDIT_PATTERN = /\b(patch|modify|write|implement|refactor|fix)\b.{0,80}\b(source code|codebase|repository|repo|component|typescript|migration|schema|dispatcher-bundle|dashboard|api route|source implementation|implementation source)\b|(?<!do not )(?<!don't )\b(edit|change)\b.{0,80}\b(source code|codebase|repository|repo|component|typescript|migration|schema|dispatcher-bundle|dashboard|api route|source implementation|implementation source)\b|\b(add|update)\b.{0,80}\b(test|vitest|migration|schema|component|route)\b/i;

export function evaluateTaskWorkspacePolicy(
  ctx: SessionContext,
  options: WorkspacePolicyOptions = {},
): WorkspacePolicyDecision {
  const signals: string[] = [];
  const forbiddenRoots = normalizeRoots(options.forbiddenRoots ?? envRoots("HIVEWRIGHT_FORBIDDEN_SOURCE_ROOTS", DEFAULT_FORBIDDEN_ROOTS));
  const operationalInstallRoot = normalizeRoot(
    options.operationalInstallRoot ?? process.env.HIVEWRIGHT_OPERATIONAL_INSTALL_ROOT ?? DEFAULT_OPERATIONAL_INSTALL_ROOT,
  );
  const approvedCodeWorkspaceRoots = normalizeRoots(
    options.approvedCodeWorkspaceRoots ?? envRoots("HIVEWRIGHT_APPROVED_CODE_WORKSPACE_ROOTS", DEFAULT_APPROVED_CODE_WORKSPACE_ROOTS),
  );
  const requireActiveIsolation = options.requireActiveIsolation ?? true;

  const candidatePaths = collectCandidateWorkspacePaths(ctx);
  for (const candidate of candidatePaths) {
    const forbidden = forbiddenRoots.find((root) => pathWithin(candidate, root));
    if (forbidden) {
      signals.push(`forbidden workspace path: ${candidate}`);
      return blocked(
        `workspace_policy_blocked: Refusing to spawn agent in forbidden HiveWright legacy/archive path (${candidate}). Approved source must be assigned by project_id; never discover source from /home/trent/hivewrightv2 or archives.`,
        signals,
      );
    }
  }

  const codeChangingTask = isCodeChangingTask(ctx.task);
  if (!codeChangingTask) {
    signals.push("non_code_changing_task");
    return { allowed: true, reason: null, signals };
  }

  signals.push("code_changing_task");
  if (ctx.gitBackedProject !== true || !ctx.task.projectId) {
    return blocked(
      "workspace_policy_blocked: Code-changing task has no approved git-backed project_id. Re-queue through an approved Git development workflow instead of letting an agent discover app source from the filesystem.",
      signals,
    );
  }

  const baseWorkspace = ctx.workspaceIsolation?.baseWorkspacePath ?? ctx.baseProjectWorkspace ?? ctx.projectWorkspace;
  if (!baseWorkspace) {
    return blocked(
      "workspace_policy_blocked: Code-changing task has no resolved project workspace. Re-queue with an approved git-backed project workspace.",
      signals,
    );
  }

  const normalizedBase = normalizeRoot(baseWorkspace);
  if (operationalInstallRoot && pathWithin(normalizedBase, operationalInstallRoot)) {
    signals.push(`operational install workspace: ${normalizedBase}`);
    return blocked(
      `workspace_policy_blocked: Code-changing task resolved to the local operational install (${normalizedBase}). Development must run from an approved Git-backed dev workspace, not /home/trent/apps/HiveWright.`,
      signals,
    );
  }

  const productCodeTask = isHiveWrightProductCodeTask(ctx.task);
  if (productCodeTask) {
    signals.push("hivewright_product_code_task");
    if (!approvedCodeWorkspaceRoots.some((root) => pathWithin(normalizedBase, root))) {
      signals.push(`unapproved hivewright code workspace: ${normalizedBase}`);
      return blocked(
        `workspace_policy_blocked: HiveWright code-changing task resolved to an unapproved workspace (${normalizedBase}). Approved roots: ${approvedCodeWorkspaceRoots.join(", ")}.`,
        signals,
      );
    }
  }

  if (requireActiveIsolation && (ctx.workspaceIsolation?.status !== "active" || !ctx.workspaceIsolation.worktreePath)) {
    signals.push(`workspace isolation status: ${ctx.workspaceIsolation?.status ?? "missing"}`);
    return blocked(
      "workspace_policy_blocked: Code-changing task requires an active dispatcher-provisioned git worktree before agent spawn.",
      signals,
    );
  }

  signals.push(requireActiveIsolation ? "approved_git_backed_isolated_workspace" : "approved_git_backed_workspace_pre_provision");
  return { allowed: true, reason: null, signals };
}

export function isCodeChangingTask(task: Pick<ClaimedTask, "assignedTo" | "title" | "brief" | "acceptanceCriteria">): boolean {
  const text = taskText(task);
  const codeRole = CODE_ROLE_SLUGS.has(task.assignedTo.trim().toLowerCase());
  const doctorRole = task.assignedTo.trim().toLowerCase() === "doctor";
  const codeSignals = CODE_CHANGE_PATTERN.test(text);
  const hivewrightSignals = HIVEWRIGHT_PRODUCT_PATTERN.test(text);
  const readOnlyNonCodeIntent = READ_ONLY_NON_CODE_PATTERN.test(text);
  const explicitSourceEditIntent = EXPLICIT_SOURCE_EDIT_PATTERN.test(text);
  const positiveSourceEditIntent = POSITIVE_SOURCE_EDIT_PATTERN.test(text);
  const recoveryNonCodeIntent = NON_CODE_RECOVERY_PATTERN.test(text) && !explicitSourceEditIntent;
  const explicitNonImplementationIntent = EXPLICIT_NON_IMPLEMENTATION_PATTERN.test(text) && !explicitSourceEditIntent;
  const complianceReadOnlyArtifactIntent = COMPLIANCE_READ_ONLY_ARTIFACT_PATTERN.test(text)
    && explicitNonImplementationIntent
    && !explicitSourceEditIntent;
  const qaReviewOnlyIntent = task.assignedTo.trim().toLowerCase() === "qa" && QA_REVIEW_ONLY_PATTERN.test(text) && !explicitSourceEditIntent;

  if (doctorRole) return false;
  if (qaReviewOnlyIntent) return false;
  if (!codeRole && ((readOnlyNonCodeIntent && !positiveSourceEditIntent) || recoveryNonCodeIntent || complianceReadOnlyArtifactIntent)) return false;
  if (codeRole && recoveryNonCodeIntent && !explicitSourceEditIntent) return false;

  return (codeRole && codeSignals) || (hivewrightSignals && PRODUCT_CODE_CHANGE_PATTERN.test(text));
}

export function isHiveWrightProductCodeTask(task: Pick<ClaimedTask, "assignedTo" | "title" | "brief" | "acceptanceCriteria">): boolean {
  const text = taskText(task);
  return isCodeChangingTask(task) && HIVEWRIGHT_PRODUCT_PATTERN.test(text);
}

/** Backward-compatible alias for earlier callers/tests. */
export const isHiveWrightCodeTask = isHiveWrightProductCodeTask;

function blocked(reason: string, signals: string[]): WorkspacePolicyDecision {
  return { allowed: false, reason, signals };
}

function taskText(task: Pick<ClaimedTask, "assignedTo" | "title" | "brief" | "acceptanceCriteria">): string {
  return [task.assignedTo, task.title, task.brief, task.acceptanceCriteria]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

function collectCandidateWorkspacePaths(ctx: SessionContext): string[] {
  const values = [
    ctx.projectWorkspace,
    ctx.baseProjectWorkspace,
    ctx.workspaceIsolation?.baseWorkspacePath,
    ctx.workspaceIsolation?.worktreePath,
    ctx.worktreeContext?.baseWorkspace,
    ctx.worktreeContext?.effectiveWorkspace,
    ctx.worktreeContext?.worktreePath,
  ];
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map(normalizeRoot)));
}

export function isForbiddenHiveWrightWorkspacePath(
  workspace: string,
  forbiddenRoots: string[] = envRoots("HIVEWRIGHT_FORBIDDEN_SOURCE_ROOTS", DEFAULT_FORBIDDEN_ROOTS),
): boolean {
  const normalizedWorkspace = normalizeRoot(workspace);
  return normalizeRoots(forbiddenRoots).some((root) => pathWithin(normalizedWorkspace, root));
}

export function assertNotForbiddenHiveWrightWorkspace(workspace: string): void {
  if (!isForbiddenHiveWrightWorkspacePath(workspace)) return;
  throw new Error(
    `workspace_policy_blocked: Refusing to spawn agent in forbidden HiveWright legacy/archive path (${normalizeRoot(workspace)}).`,
  );
}

function envRoots(name: string, defaults: string[]): string[] {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return defaults;
  const parsed = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return Array.from(new Set([...defaults, ...parsed]));
}

function normalizeRoots(values: string[]): string[] {
  return Array.from(new Set(values.flatMap(normalizePathCandidates).filter(Boolean)));
}

function normalizeRoot(value: string | null | undefined): string {
  return normalizePathCandidates(value)[0] ?? "";
}

function normalizePathCandidates(value: string | null | undefined): string[] {
  if (!value) return [];
  const resolved = path.resolve(value.trim());
  if (!resolved) return [];
  const candidates = [resolved];
  try {
    const real = fs.realpathSync.native(resolved);
    if (real && real !== resolved) candidates.push(real);
  } catch {
    // Non-existent worktree paths are still checked by their resolved path.
  }
  return candidates;
}

function pathWithin(candidatePath: string, rootPath: string): boolean {
  if (!candidatePath || !rootPath) return false;
  const candidates = normalizePathCandidates(candidatePath);
  const roots = normalizePathCandidates(rootPath);
  return candidates.some((candidate) => roots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }));
}
