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
const READ_ONLY_NON_CODE_PATTERN = /\b(do not|don't|without)\b.{0,120}\b(edit|change|modify|patch|write|touch|run git commands|create branches|create worktrees|commit|require)\b.{0,120}\b(code|repo|repository|repositories|source|implementation|local development|git-backed project|project checkout|branch|worktree|commit)\b|\b(do not|don't)\b.{0,120}\b(spawn|create|perform|require)\b.{0,120}\b(implementation|code change|code-changing|git-backed project|project checkout|local filesystem artifact)\b|\b(repository-neutral|research and clarification only|bounded governance-disposition pass|bounded governance disposition pass)\b|\brequires?\s+no\s+(?:git\/project\/code change|git-backed project|code change)\b|\bdo not\b.{0,80}\b(run git commands|inspect or modify code|propose)\b.{0,80}\b(hivewright product improvements|internal platform work|ai model\/runtime changes|code|repo|repository|branch|worktree|commit)?\b|\bread[- ]only\b.{0,80}\b(api|path|scan|summary|analysis|diagnosis|research|artifact|artifacts|project-scoped technical implementation map|technical implementation map)\b|\bread[- ]only\b.{0,160}\b(do not|don't)\b.{0,120}\b(create|edit|delete|commit)\b.{0,80}\b(files|branches|commits|tags|pushes)\b/i;
const READ_ONLY_OPERATIONAL_VERIFICATION_PATTERN = /\b(secret-free,\s*)?read[- ]only\b.{0,120}\b(verification|audit|inspection|check)\b.{0,160}\b(live site|github repo|repo integrity|database state|deployment posture|infrastructure state|vercel|resend)\b|\b(document|record)\b.{0,80}\b(current findings|findings)\b.{0,120}\b(without|do not|don't)\b.{0,80}\b(modifying|changing|editing|writing)\b/i;
const NON_CODE_RECOVERY_PATTERN = /\b(qa failure re-planning|replan|diagnosis only|follow-up task only|review the skill content|audit readiness|readiness artifact|readiness packet|backup|restore-smoke|evidence pack|inventory and recommendation|canonical inventory|owner approval gate memo|source task\/work-product references|retained artifact references|retained work products|current external signals|daily world scan|route investigation|preflight route investigation|adapter\/preflight route investigation|duplicate-decision addendum|governance residue)\b/i;
const COMPLIANCE_READ_ONLY_ARTIFACT_PATTERN = /\b(oaic|privacy|compliance|risk)\b.{0,160}\b(checklist\/table|checklist|finite table|internal artifacts|source references)\b|\b(checklist\/table|checklist|finite table|internal artifacts|source references)\b.{0,160}\b(oaic|privacy|compliance|risk)\b/i;
const EXPLICIT_NON_IMPLEMENTATION_PATTERN = /\b(do not|don't)\b.{0,120}\b(live probes|production\/?customer data|configuration changes|config changes|vendor contact|external-facing policy text)\b|\bmark it as unknown or defer\b|\bmitigation(?:s)?\b.{0,80}\b(internal-safe|implementation-later|owner-gated|defer)\b/i;
const QA_REVIEW_ONLY_PATTERN = /\b(review|evaluate|verify)\b.{0,120}\b(deliverable|artifact|acceptance criteria|pass|fail)\b|\bfirst non-empty line\b.{0,80}\b(pass|fail)\b/i;
const QA_WRAPPER_PATTERN = /^\[QA\]\s*Review:|##\s*QA Review/i;
const QA_WRAPPER_EXPLICIT_SOURCE_EDIT_PATTERN = /\b(patch|modify|edit|change|write|implement|refactor|fix)\b.{0,100}\b(HiveWright\s+)?(dashboard\/API\s+)?(source code|codebase|repository|repo|component|typescript|migration|schema|dispatcher-bundle|dashboard|api route|source implementation|implementation code)\b|\badd\b.{0,80}\b(Vitest|test|regression)\b/i;
const SUPERVISOR_ADMIN_REPORT_PATTERN = /\b(hive\s+supervisor\s+heartbeat|supervisor\s+heartbeat|hive\s+health\s+report|health\s+report|heartbeat\s+report|report\/routing\s+packet|administrative\s+(?:health|report|routing)|route[- ]health\s+counts|supervisor\s+actions|findings_addressed)\b|\bfinding\(s\)\b/i;
const DOCUMENT_ONLY_ARTIFACT_PATTERN = /\b(document-only|markdown artifact|final markdown artifact|decision-ready remediation artifact|route\/flow evidence table|route\/flow matrix|evidence matrix|documented route\/flow matrix|synthesis|source-use boundary requirements|provenance tracking|remediation backlog)\b/i;
const NON_CODE_ARTIFACT_ROLES = new Set([
  "document-manager",
  "reference-document-reviewer",
  "research-analyst",
  "financial-analyst",
  "operations-coordinator",
  "compliance-risk-analyst",
]);
const EXPLICIT_SOURCE_EDIT_PATTERN = /\b(patch|modify|edit|change|write|implement|refactor|fix)\b.{0,80}\b(source code|codebase|repository|repo|component|typescript|migration|schema|dispatcher-bundle|dashboard|api route|source implementation|implementation code)\b|\b(add|update)\b.{0,80}\b(test|vitest|migration|schema|component|api route)\b/i;
const POSITIVE_SOURCE_EDIT_PATTERN = /\b(patch|modify|write|implement|refactor|fix)\b.{0,80}\b(source code|codebase|repository|repo|component|typescript|migration|schema|dispatcher-bundle|dashboard|api route|source implementation|implementation source|implementation code)\b|(?<!do not )(?<!don't )\b(edit|change)\b.{0,80}\b(source code|codebase|repository|repo|component|typescript|migration|schema|dispatcher-bundle|dashboard|api route|source implementation|implementation source|implementation code)\b|\b(add|update)\b.{0,80}\b(test|vitest|migration|schema|component|api route)\b/i;
const NEGATED_SOURCE_EDIT_PATTERN = /\b(do not|don't|without|not)\b.{0,60}\b(edit|change|modify|patch|write|touch|inspect|attempt|create|perform|require)\b.{0,140}\b(code|repo|repository|repositories|source|implementation code|source implementation|codebase|component|typescript|migration|schema|dashboard|api route|configuration files?)\b|\b(do not|don't|without|not)\b.{0,100}\bcode changes?\b.{0,80}\bfix\b.{0,80}\b(schema|byline|metadata|social-image|defects?)\b/gi;
const HTTP_ENDPOINT_REFERENCE_PATTERN = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[A-Za-z0-9_./:[\]-]+/g;

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

  const codeChangingTask = isCodeChangingTaskForHive(ctx.task, ctx.hiveSlug);
  if (!codeChangingTask) {
    signals.push("non_code_changing_task");
    return { allowed: true, reason: null, signals };
  }

  signals.push("code_changing_task");
  if (ctx.gitBackedProject !== true || !ctx.task.projectId) {
    return blocked(
      "workspace_policy_blocked: Code-changing task has no approved git-backed project_id. Supervisor/operator: re-queue through an approved Git development workflow instead of letting an agent discover app source from the filesystem.",
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

  const hiveSlug = ctx.hiveSlug?.trim().toLowerCase() ?? null;
  const productCodeTask = (hiveSlug === null || hiveSlug === "hivewright") && isHiveWrightProductCodeTask(ctx.task);
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
  return isCodeChangingTaskForHive(task, null);
}

function isCodeChangingTaskForHive(
  task: Pick<ClaimedTask, "assignedTo" | "title" | "brief" | "acceptanceCriteria">,
  hiveSlug: string | null | undefined,
): boolean {
  const text = taskText(task);
  const normalizedHiveSlug = hiveSlug?.trim().toLowerCase() ?? null;
  const inHiveWrightHive = normalizedHiveSlug === null || normalizedHiveSlug === "hivewright";
  const codeRole = CODE_ROLE_SLUGS.has(task.assignedTo.trim().toLowerCase());
  const doctorRole = task.assignedTo.trim().toLowerCase() === "doctor";
  const codeSignals = CODE_CHANGE_PATTERN.test(text);
  const hivewrightSignals = HIVEWRIGHT_PRODUCT_PATTERN.test(text);
  const readOnlyNonCodeIntent = READ_ONLY_NON_CODE_PATTERN.test(text);
  const explicitReadOnlyNoFileMutation = /\bread[- ]only\b/i.test(text)
    && /\bdo not\b.{0,120}\b(create|edit|delete|commit)\b.{0,80}\b(files|branches|commits|tags|pushes)\b/i.test(text);
  const readOnlyOperationalVerificationIntent = READ_ONLY_OPERATIONAL_VERIFICATION_PATTERN.test(text);
  const sourceIntentText = text
    .replace(HTTP_ENDPOINT_REFERENCE_PATTERN, " ")
    .replace(NEGATED_SOURCE_EDIT_PATTERN, " ");
  const explicitSourceEditIntent = EXPLICIT_SOURCE_EDIT_PATTERN.test(sourceIntentText);
  const positiveSourceEditIntent = POSITIVE_SOURCE_EDIT_PATTERN.test(sourceIntentText);
  const recoveryNonCodeIntent = NON_CODE_RECOVERY_PATTERN.test(text) && !explicitSourceEditIntent;
  const explicitNonImplementationIntent = EXPLICIT_NON_IMPLEMENTATION_PATTERN.test(text) && !explicitSourceEditIntent;
  const complianceReadOnlyArtifactIntent = COMPLIANCE_READ_ONLY_ARTIFACT_PATTERN.test(text)
    && explicitNonImplementationIntent
    && !explicitSourceEditIntent;
  const assignedRole = task.assignedTo.trim().toLowerCase();
  const supervisorReportSourceIntentText = stripSupervisorReportEvidence(sourceIntentText);
  const supervisorReportExplicitSourceEditIntent = EXPLICIT_SOURCE_EDIT_PATTERN.test(supervisorReportSourceIntentText);
  const supervisorReportPositiveSourceEditIntent = POSITIVE_SOURCE_EDIT_PATTERN.test(supervisorReportSourceIntentText);
  const supervisorAdminReportIntent = assignedRole === "hive-supervisor"
    && SUPERVISOR_ADMIN_REPORT_PATTERN.test(text)
    && !supervisorReportExplicitSourceEditIntent
    && !supervisorReportPositiveSourceEditIntent;
  const qaReviewOnlyIntent = assignedRole === "qa"
    && (QA_WRAPPER_PATTERN.test(text) || QA_REVIEW_ONLY_PATTERN.test(text))
    && !QA_WRAPPER_EXPLICIT_SOURCE_EDIT_PATTERN.test(sourceIntentText);
  const nonCodeArtifactIntent = NON_CODE_ARTIFACT_ROLES.has(assignedRole)
    && DOCUMENT_ONLY_ARTIFACT_PATTERN.test(text)
    && !explicitSourceEditIntent;

  if (doctorRole) return false;
  if (supervisorAdminReportIntent) return false;
  if (qaReviewOnlyIntent) return false;
  if (nonCodeArtifactIntent) return false;
  if (explicitReadOnlyNoFileMutation) return false;
  if ((readOnlyNonCodeIntent || readOnlyOperationalVerificationIntent || recoveryNonCodeIntent || complianceReadOnlyArtifactIntent) && !explicitSourceEditIntent && !positiveSourceEditIntent) return false;

  return (codeRole && codeSignals) || (inHiveWrightHive && hivewrightSignals && PRODUCT_CODE_CHANGE_PATTERN.test(text));
}

export function isHiveWrightProductCodeTask(task: Pick<ClaimedTask, "assignedTo" | "title" | "brief" | "acceptanceCriteria">): boolean {
  const text = stripPriorWorkspacePolicyFeedback(taskText(task));
  return isCodeChangingTask(task) && HIVEWRIGHT_PRODUCT_PATTERN.test(text);
}

function stripPriorWorkspacePolicyFeedback(text: string): string {
  return text
    .replace(/###\s*QA Feedback\s*\nworkspace_policy_blocked: HiveWright code-changing task[^\n]*(?:\n|$)/gi, "\n")
    .replace(/workspace_policy_blocked: HiveWright code-changing task[^\n]*(?:\n|$)/gi, "\n");
}

function stripSupervisorReportEvidence(text: string): string {
  const evidenceHeadingPattern = /^(?:#{1,6}\s*)?(?:findings?|task evidence|latest task evidence|scan summar(?:y|ies)|runtime\/source evidence)\b/i;
  const evidenceLinePattern = /\b(finding|task evidence|latest task evidence|scan summar(?:y|ies)|quoted evidence|quoted implementation|stalled implementation task|failed implementation task|workspace_policy_blocked)\b/i;
  const evidenceListItemPattern = /^\s*(?:[-*+]|\d+[.)]|>)\s+(?:[A-Z]+-\d+\b|(?:evidence|quoted|stalled|failed|workspace_policy_blocked)\b)/i;
  let inEvidenceSection = false;

  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (evidenceHeadingPattern.test(trimmed)) {
        inEvidenceSection = true;
        return false;
      }
      if (inEvidenceSection && /^#{1,6}\s+\S/.test(trimmed)) {
        inEvidenceSection = false;
      }
      if (evidenceLinePattern.test(line)) return false;
      if (inEvidenceSection && evidenceListItemPattern.test(line)) return false;
      return true;
    })
    .join("\n");
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
