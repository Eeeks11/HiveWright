import { resolveHiveWrightBuildProvenance } from "@/diagnostics/build-provenance";

export interface DeploymentProofEvidenceInput {
  projectGitRepo: boolean;
  taskTitle?: string | null;
  taskBrief?: string | null;
  acceptanceCriteria?: string | null;
  resultSummary?: string | null;
  qaFeedback?: string | null;
  workProductSummary?: string | null;
  workProductContent?: string | null;
  currentRuntimeBuildHash?: string | null;
}

export interface DeploymentProofEvidenceResult {
  required: boolean;
  ok: boolean;
  expectedCommit: string | null;
  liveBuildHash: string | null;
  currentRuntimeBuildHash: string | null;
  failures: string[];
}

const DEPLOYMENT_SENSITIVE_PATTERN = /\b(deploy(?:ed|ment)?|live|production|prod|operational checkout|runtime checkout|same-build|build hash|restart(?:ed)? service|systemd|cutover|release)\b/i;
const WORKTREE_ONLY_PATTERN = /\b(task worktree|worktree qa|passed in (?:the )?worktree|local qa|focused tests|typecheck|unit tests)\b/i;
const SHA_PATTERN = "([a-f0-9]{7,40})";

const EXPECTED_COMMIT_PATTERNS = [
  new RegExp(`\\b(?:expected|required|work|fix|source|task|pr)\\s+(?:commit|sha|build(?:\\s+hash)?)\\b[^a-f0-9]{0,80}${SHA_PATTERN}`, "i"),
  new RegExp(`\\b(?:commit|sha)\\b[^a-f0-9]{0,30}${SHA_PATTERN}`, "i"),
];

const LIVE_BUILD_PATTERNS = [
  new RegExp(`\\b(?:deployed|live|operational|runtime|current\\s+runtime|production|prod)\\s+(?:checkout\\s+)?(?:commit|sha|build|build\\s+hash)\\b[^a-f0-9]{0,80}${SHA_PATTERN}`, "i"),
  new RegExp(`\\b(?:deployed|live|operational|runtime|production|prod)\\b[^a-f0-9]{0,80}${SHA_PATTERN}`, "i"),
];

export function evaluateDeploymentSensitiveCompletionEvidence(
  input: DeploymentProofEvidenceInput,
): DeploymentProofEvidenceResult {
  const currentRuntimeBuildHash = normalizeSha(
    input.currentRuntimeBuildHash ?? resolveHiveWrightBuildProvenance().buildHash,
  );
  const text = [
    input.taskTitle,
    input.taskBrief,
    input.acceptanceCriteria,
    input.resultSummary,
    input.qaFeedback,
    input.workProductSummary,
    input.workProductContent,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n\n");

  const required = input.projectGitRepo && DEPLOYMENT_SENSITIVE_PATTERN.test(text);
  if (!required) {
    return {
      required: false,
      ok: true,
      expectedCommit: extractSha(text, EXPECTED_COMMIT_PATTERNS),
      liveBuildHash: extractSha(text, LIVE_BUILD_PATTERNS),
      currentRuntimeBuildHash,
      failures: [],
    };
  }

  const expectedCommit = extractSha(text, EXPECTED_COMMIT_PATTERNS);
  const liveBuildHash = extractSha(text, LIVE_BUILD_PATTERNS);
  const failures: string[] = [];

  if (!expectedCommit) {
    failures.push("Deployment-sensitive completion requires an explicit expected work commit/build hash.");
  }
  if (!liveBuildHash) {
    failures.push("Deployment-sensitive completion requires explicit live operational checkout/build-hash evidence; task-worktree QA alone is not live proof.");
  }
  if (!currentRuntimeBuildHash) {
    failures.push("Deployment-sensitive completion requires the current runtime build hash to be available.");
  }
  if (expectedCommit && liveBuildHash && !sameCommit(expectedCommit, liveBuildHash)) {
    failures.push(`Live operational build hash ${liveBuildHash} does not match expected work commit ${expectedCommit}.`);
  }
  if (expectedCommit && currentRuntimeBuildHash && !sameCommit(expectedCommit, currentRuntimeBuildHash)) {
    failures.push(`Current runtime build hash ${currentRuntimeBuildHash} does not contain expected work commit ${expectedCommit}.`);
  }
  if (WORKTREE_ONLY_PATTERN.test(text) && !liveBuildHash) {
    failures.push("Completion evidence distinguishes only worktree/test proof; same-build live deployment proof is missing.");
  }

  return {
    required,
    ok: failures.length === 0,
    expectedCommit,
    liveBuildHash,
    currentRuntimeBuildHash,
    failures,
  };
}

export function formatDeploymentProofFailure(failures: string[]): string {
  return `Deployment-sensitive completion blocked: ${failures.join(" ")}`;
}

function extractSha(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = normalizeSha(match?.[1] ?? null);
    if (value) return value;
  }
  return null;
}

function normalizeSha(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  const match = normalized.match(/^[a-f0-9]{7,40}$/);
  return match ? normalized : null;
}

function sameCommit(left: string, right: string): boolean {
  const a = normalizeSha(left);
  const b = normalizeSha(right);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}
