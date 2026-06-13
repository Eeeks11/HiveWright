import type { FinalDispositionLabel } from "@/closeout/registry";

export type GitHubIssueState = "OPEN" | "CLOSED";

export type GitHubIssueCloseoutClassification =
  | "backlog_open"
  | "landed_verified"
  | "stale_or_drifted";

export interface GitHubIssueObservation {
  owner: string;
  repo: string;
  number: number;
  state: GitHubIssueState | Lowercase<GitHubIssueState>;
  title?: string | null;
  labels?: string[];
  linkedPullRequests?: GitHubLinkedPullRequest[];
  evidence?: GitHubIssueCloseoutEvidence | null;
}

export interface GitHubLinkedPullRequest {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED" | Lowercase<"OPEN" | "MERGED" | "CLOSED">;
  mergeCommitOid?: string | null;
  headRefOid?: string | null;
}

export interface GitHubIssueCloseoutEvidence {
  landedCommitOids?: string[];
  verifiedCommitOids?: string[];
  deployedCommitOids?: string[];
  runtimeVerifiedCommitOids?: string[];
  unresolvedFindingKeys?: string[];
}

export interface GitHubIssueCloseoutResult {
  issueRef: string;
  classification: GitHubIssueCloseoutClassification;
  finalDispositionLabel: Extract<
    FinalDispositionLabel,
    "github_issue_backlog_open" | "github_issue_landed_verified" | "github_issue_stale_or_drifted"
  >;
  canAutoClose: boolean;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  relatedCommitOids: string[];
}

function normalizeState(value: string): string {
  return value.trim().toUpperCase();
}

function compactStrings(values: readonly (string | null | undefined)[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function hasIntersection(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function mergedPullRequestCommits(issue: GitHubIssueObservation): string[] {
  return compactStrings(
    (issue.linkedPullRequests ?? [])
      .filter((pullRequest) => normalizeState(pullRequest.state) === "MERGED")
      .flatMap((pullRequest) => [pullRequest.mergeCommitOid, pullRequest.headRefOid]),
  );
}

function issueRef(issue: GitHubIssueObservation): string {
  return `${issue.owner}/${issue.repo}#${issue.number}`;
}

export function classifyGitHubIssueCloseout(
  issue: GitHubIssueObservation,
): GitHubIssueCloseoutResult {
  const state = normalizeState(issue.state);
  const evidence = issue.evidence ?? {};
  const linkedMergedCommits = mergedPullRequestCommits(issue);
  const landedCommits = compactStrings([...(evidence.landedCommitOids ?? []), ...linkedMergedCommits]);
  const verifiedCommits = compactStrings([
    ...(evidence.verifiedCommitOids ?? []),
    ...(evidence.deployedCommitOids ?? []),
    ...(evidence.runtimeVerifiedCommitOids ?? []),
  ]);
  const unresolvedFindingKeys = compactStrings(evidence.unresolvedFindingKeys);
  const reasons: string[] = [];

  if (state === "OPEN") {
    if (unresolvedFindingKeys.length > 0) {
      reasons.push(`open issue still has unresolved finding keys: ${unresolvedFindingKeys.join(", ")}`);
    } else {
      reasons.push("issue is still open and should remain backlog until landed verification is explicit");
    }

    return {
      issueRef: issueRef(issue),
      classification: "backlog_open",
      finalDispositionLabel: "github_issue_backlog_open",
      canAutoClose: false,
      confidence: unresolvedFindingKeys.length > 0 ? "high" : "medium",
      reasons,
      relatedCommitOids: landedCommits,
    };
  }

  if (state !== "CLOSED") {
    return {
      issueRef: issueRef(issue),
      classification: "stale_or_drifted",
      finalDispositionLabel: "github_issue_stale_or_drifted",
      canAutoClose: false,
      confidence: "high",
      reasons: [`unsupported GitHub issue state: ${issue.state}`],
      relatedCommitOids: landedCommits,
    };
  }

  if (landedCommits.length === 0) {
    return {
      issueRef: issueRef(issue),
      classification: "stale_or_drifted",
      finalDispositionLabel: "github_issue_stale_or_drifted",
      canAutoClose: false,
      confidence: "high",
      reasons: ["closed issue has no linked landed commit evidence"],
      relatedCommitOids: [],
    };
  }

  if (!hasIntersection(landedCommits, verifiedCommits)) {
    return {
      issueRef: issueRef(issue),
      classification: "stale_or_drifted",
      finalDispositionLabel: "github_issue_stale_or_drifted",
      canAutoClose: false,
      confidence: "high",
      reasons: ["closed issue has landed commits, but none are verified by deployed/runtime evidence"],
      relatedCommitOids: landedCommits,
    };
  }

  return {
    issueRef: issueRef(issue),
    classification: "landed_verified",
    finalDispositionLabel: "github_issue_landed_verified",
    canAutoClose: true,
    confidence: "high",
    reasons: ["closed issue has landed commit evidence that matches deployed/runtime verification"],
    relatedCommitOids: landedCommits,
  };
}

export function classifyGitHubIssueCloseouts(
  issues: readonly GitHubIssueObservation[],
): GitHubIssueCloseoutResult[] {
  return issues.map((issue) => classifyGitHubIssueCloseout(issue));
}
