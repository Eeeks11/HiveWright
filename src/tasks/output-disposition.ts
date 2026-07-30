import type {
  ClosureScope,
  DecisionBoundary,
  FinalDispositionLabel,
  StorageRootFamily,
  TerminalStatus,
} from "@/closeout/registry";

export const ANALYST_OUTPUT_DISPOSITION_KIND = "analyst_output_disposition";
export const GITHUB_ISSUE_OR_PR_ROUTE_PREFIX = "GitHub issue/PR route:";
export const DELIBERATE_NO_FOLLOW_UP_TERMINAL_DISPOSITION_PREFIX =
  "Deliberate no-follow-up terminal disposition:";

const GITHUB_ROUTE_RE =
  /https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+|\bgithub\s+(?:issue|pr|pull request)\s*#?\d+\b|\b(?:issue|pr|pull request)\s*#\d+\b|(?<![\w/])#\d+\b/gi;

const GITHUB_RELEASE_URL_RE = /https:\/\/github\.com\/[^\s)]+\/releases\/tag\/[^\s)]+/gi;

const DELIBERATE_NO_FOLLOW_UP_RE =
  /\b(?:deliberate|explicit|intentional|accepted|bounded|terminal)\b.{0,80}\b(?:no[-\s]?follow[-\s]?up|no\s+follow\s+up|no[-\s]?action|no\s+new\s+(?:issue|pr|decision|follow[-\s]?up)|terminal\s+closeout|no\s+further\s+action)\b|\b(?:no[-\s]?follow[-\s]?up|no\s+follow\s+up|no[-\s]?action|no\s+new\s+(?:issue|pr|decision|follow[-\s]?up)|terminal\s+closeout|no\s+further\s+action)\b.{0,80}\b(?:deliberate|explicit|intentional|accepted|bounded|terminal|recorded)\b/i;

const NEGATED_CANONICAL_DISPOSITION_RE =
  /\b(?:no|without|missing)\b.{0,80}\b(?:github\s+)?(?:issue|pr|pull request|route|routing|terminal\s+disposition|no[-\s]?follow[-\s]?up\s+disposition)\b.{0,80}\b(?:recorded|published|created|opened|filed|linked)\b/i;

const ROUTING_PUBLICATION_TASK_RE =
  /\b(?:route|routing|publish|publication|promote|promotion|open|create|file)\b.{0,90}\b(?:github|issue|pr|pull request|backlog)\b|\b(?:github|issue|pr|pull request|backlog)\b.{0,90}\b(?:route|routing|publish|publication|promote|promotion|open|create|file)\b|\bprior\s+findings?\b.{0,90}\b(?:github|issue|pr|pull request|publish|route|routing)\b/i;
const EXPLICIT_ROUTING_PUBLICATION_TASK_RE =
  /\b(?:route|routing|publish|publication|promote|promotion|open|create|file)\b.{0,90}\b(?:issue|pr|pull request|backlog)\b|\b(?:issue|pr|pull request|backlog)\b.{0,90}\b(?:route|routing|publish|publication|promote|promotion|open|create|file)\b|\bprior\s+findings?\b.{0,90}\b(?:issue|pr|pull request|backlog|route|routing)\b/i;
const GITHUB_RELEASE_PUBLICATION_TASK_RE =
  /\b(?:create|publish|publication|promote|promotion|release)\b.{0,90}\bgithub\s+releases?\b|\bgithub\s+releases?\b.{0,90}\b(?:create|publish|publication|promote|promotion|release)\b|\breleases?\/tag\b/i;

const ANALYST_OUTPUT_ROLE_RE =
  /(?:^|[-_])(analyst|auditor|coordinator)(?:$|[-_])|^(?:performance-analyst|research-analyst|system-health-auditor|operations-coordinator)$/i;

const SKILL_QA_TITLE_PATTERN = /^\[Skill QA\]\s*Review:/i;
const SKILL_QA_COPIED_EVIDENCE_SECTION_PATTERNS = [
  /(?:^|\n)(?:#{1,6}\s*)?Copied incident evidence(?:\s+from [^\n:]+)?\s*:\n[\s\S]*$/i,
  /(?:^|\n)(?:#{1,6}\s*)?Accepted investigation evidence(?:\s+from [^\n:]+)?\s*:\n[\s\S]*$/i,
] as const;

const CLOSEOUT_SCOPE_PATTERNS = [
  /\brouting\/publication\b/i,
  /\bpublication-path contract\b/i,
  /\b(?:routing|publication|improvement[-\s]?scan)\b[\s\S]{0,120}\b(?:closeout|completion|prompt|result|summary|final answer|task result|terminal disposition)\b/i,
  /\b(?:closeout|completion|prompt|result summary|final answer|task result|terminal disposition)\b[\s\S]{0,120}\b(?:routing|publication|improvement[-\s]?scan)\b/i,
] as const;

const EXPLICIT_TERMINAL_DISPOSITION_CONTRACT_PATTERNS = [
  /\b(?:final answer|final result|task result|result summary|qa result|review result)\b[\s\S]{0,160}\b(?:exactly one|one canonical)\b[\s\S]{0,80}\bterminal disposition line\b/i,
  /\bterminal disposition line\b[\s\S]{0,160}\b(?:begin|beginning)\b[\s\S]{0,80}\b(?:github issue\/pr route|deliberate no-follow-up terminal disposition)\b/i,
] as const;

const DISPOSITION_REQUIREMENT_PATTERNS = [
  /\bgithub\s+(?:issue|pr|pull request)\b/i,
  /\bissue\/pr\b/i,
  /\bterminal disposition\b/i,
  /\bno downstream tracker\b/i,
  /\bno-follow-up\b/i,
] as const;

const RESULT_SURFACE_PATTERNS = [
  /\b(?:final answer|final result|task result|result summary|qa result|review result)\b/i,
] as const;

export interface OutputDispositionTaskLike {
  title?: string | null;
  brief?: string | null;
  acceptanceCriteria?: string | null;
}

export const QA_NO_FOLLOW_UP_TERMINAL_DISPOSITION_LINE =
  `${DELIBERATE_NO_FOLLOW_UP_TERMINAL_DISPOSITION_PREFIX} QA review is terminal; any required rework stays on the parent task instead of creating a downstream tracker from this QA task.`;

export type AnalystOutputDisposition = {
  schemaVersion: 1;
  kind: typeof ANALYST_OUTPUT_DISPOSITION_KIND;
  terminal: true;
  recordedAt: string;
  source:
    | "dispatcher.completeTask.outputDisposition"
    | "supervisor.referenceOnlyTerminalDisposition.analystOutput";
  reason: string;
  terminal_status: TerminalStatus;
  final_disposition_label: FinalDispositionLabel;
  closure_scope: ClosureScope;
  decision_boundary: DecisionBoundary;
  storage_root_family: StorageRootFamily;
  source_finding: {
    kind: "unsatisfied_completion" | "orphan_output";
    key: string;
    evidence_ref: string;
  };
  source_record_ref: {
    table: "tasks";
    id: string;
    field: "terminal_disposition";
  };
  task: {
    id: string;
    hiveId: string;
    roleSlug: string;
  };
  evidence: {
    disposition: "github_route" | "deliberate_no_follow_up";
    githubRefs: string[];
    resultSummaryPresent: boolean;
  };
  safeguards: {
    canonicalDispositionRequired: true;
    routeOrNoFollowUpRecorded: true;
  };
};

export type TaskDispositionContext = {
  id: string;
  hiveId: string;
  assignedTo: string;
  title: string;
  brief: string | null;
};

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function buildDispositionHaystack(input: OutputDispositionTaskLike): string {
  let brief = input.brief ?? "";
  if (SKILL_QA_TITLE_PATTERN.test(input.title ?? "")) {
    for (const pattern of SKILL_QA_COPIED_EVIDENCE_SECTION_PATTERNS) {
      brief = brief.replace(pattern, "");
    }
  }

  return [
    input.title ?? "",
    brief,
    input.acceptanceCriteria ?? "",
  ].join("\n");
}

export function taskRequiresOutputDisposition(
  input: OutputDispositionTaskLike,
): boolean {
  const haystack = buildDispositionHaystack(input);
  return (
    matchesAny(haystack, CLOSEOUT_SCOPE_PATTERNS)
    || matchesAny(haystack, EXPLICIT_TERMINAL_DISPOSITION_CONTRACT_PATTERNS)
  )
    && matchesAny(haystack, DISPOSITION_REQUIREMENT_PATTERNS)
    && matchesAny(haystack, RESULT_SURFACE_PATTERNS);
}

export function buildTaskOutputDispositionInstructions(): string {
  return [
    "## Terminal Disposition Line",
    "This task carries a terminal disposition closeout contract.",
    "The final result must end with exactly one terminal disposition line.",
    `That last line must begin exactly \`${GITHUB_ISSUE_OR_PR_ROUTE_PREFIX}\` or \`${DELIBERATE_NO_FOLLOW_UP_TERMINAL_DISPOSITION_PREFIX}\`.`,
    `If using \`${GITHUB_ISSUE_OR_PR_ROUTE_PREFIX}\`, include a concrete GitHub issue/PR number like \`#123\` or a full GitHub issue/PR URL.`,
    `Otherwise use \`${DELIBERATE_NO_FOLLOW_UP_TERMINAL_DISPOSITION_PREFIX} <reason no downstream tracker is needed>\`.`,
    "Do not omit this line. Do not include more than one terminal disposition line.",
  ].join("\n");
}

export function buildQaOutputDispositionInstructions(): string {
  return [
    "### QA Terminal Disposition",
    "This QA task inherits a terminal disposition closeout contract from the reviewed task.",
    "Keep the first non-empty line exactly `pass` or `fail`.",
    "After the evidence notes, end the QA result with exactly one terminal disposition line.",
    `That last line must begin exactly \`${GITHUB_ISSUE_OR_PR_ROUTE_PREFIX}\` or \`${DELIBERATE_NO_FOLLOW_UP_TERMINAL_DISPOSITION_PREFIX}\`.`,
    `Do not use \`${GITHUB_ISSUE_OR_PR_ROUTE_PREFIX}\` unless this QA task itself created or updated a concrete GitHub issue or PR and can cite \`#123\` or a full GitHub issue/PR URL.`,
    `Otherwise use exactly \`${QA_NO_FOLLOW_UP_TERMINAL_DISPOSITION_LINE}\``,
  ].join("\n");
}

export function hasTerminalDispositionLine(output: string): boolean {
  return output
    .replace(/\r/g, "")
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith(GITHUB_ISSUE_OR_PR_ROUTE_PREFIX)
        || trimmed.startsWith(DELIBERATE_NO_FOLLOW_UP_TERMINAL_DISPOSITION_PREFIX);
    });
}

export function ensureQaNoFollowUpTerminalDispositionLine(output: string): string {
  if (hasTerminalDispositionLine(output)) return output;
  const trimmed = output.trimEnd();
  return [
    trimmed,
    QA_NO_FOLLOW_UP_TERMINAL_DISPOSITION_LINE,
  ].filter(Boolean).join("\n\n");
}

export function extractGithubRouteRefs(text: string): string[] {
  GITHUB_ROUTE_RE.lastIndex = 0;
  return Array.from(new Set(Array.from(text.matchAll(GITHUB_ROUTE_RE)).map((match) => match[0]))).slice(0, 10);
}

export function extractGithubReleaseArtifactRefs(text: string): string[] {
  GITHUB_RELEASE_URL_RE.lastIndex = 0;
  return Array.from(new Set(Array.from(text.matchAll(GITHUB_RELEASE_URL_RE)).map((match) => match[0]))).slice(0, 10);
}

export function hasDeliberateNoFollowUpDisposition(text: string): boolean {
  return DELIBERATE_NO_FOLLOW_UP_RE.test(text);
}

export function isGithubReleasePublicationTask(input: Pick<TaskDispositionContext, "title" | "brief">): boolean {
  const text = [input.title, input.brief ?? ""].join("\n");
  return GITHUB_RELEASE_PUBLICATION_TASK_RE.test(text);
}

export function isRoutingPublicationTask(input: Pick<TaskDispositionContext, "assignedTo" | "title" | "brief">): boolean {
  const text = [input.assignedTo, input.title, input.brief ?? ""].join("\n");
  if (EXPLICIT_ROUTING_PUBLICATION_TASK_RE.test(text)) return true;
  if (isGithubReleasePublicationTask(input)) return false;
  return ROUTING_PUBLICATION_TASK_RE.test(text);
}

export function isAnalystOutputTask(input: Pick<TaskDispositionContext, "assignedTo" | "title" | "brief">): boolean {
  if (ANALYST_OUTPUT_ROLE_RE.test(input.assignedTo)) return true;
  return isRoutingPublicationTask(input);
}

export function findCanonicalOutputDisposition(text: string): {
  disposition: "github_route" | "deliberate_no_follow_up";
  githubRefs: string[];
} | null {
  if (NEGATED_CANONICAL_DISPOSITION_RE.test(text)) return null;
  const githubRefs = extractGithubRouteRefs(text);
  if (githubRefs.length > 0) {
    return { disposition: "github_route", githubRefs };
  }
  if (hasDeliberateNoFollowUpDisposition(text)) {
    return { disposition: "deliberate_no_follow_up", githubRefs: [] };
  }
  return null;
}

export function buildAnalystOutputDisposition(input: {
  task: TaskDispositionContext;
  resultSummary: string | null;
  disposition: "github_route" | "deliberate_no_follow_up";
  githubRefs: string[];
  now: Date;
  source: AnalystOutputDisposition["source"];
}): AnalystOutputDisposition {
  const hasGithubRoute = input.disposition === "github_route";
  return {
    schemaVersion: 1,
    kind: ANALYST_OUTPUT_DISPOSITION_KIND,
    terminal: true,
    recordedAt: input.now.toISOString(),
    source: input.source,
    reason: hasGithubRoute
      ? "Completed analyst/routing output records a canonical downstream GitHub route."
      : "Completed analyst/routing output records a deliberate no-follow-up terminal disposition.",
    terminal_status: hasGithubRoute ? "closed_with_follow_up" : "closed",
    final_disposition_label: hasGithubRoute ? "github_issue_backlog_open" : "reference_only_output",
    closure_scope: hasGithubRoute ? "github_issue" : "task",
    decision_boundary: hasGithubRoute ? "external_state_only" : "autonomous_safe",
    storage_root_family: "db_task_terminal_disposition",
    source_finding: {
      kind: hasGithubRoute ? "unsatisfied_completion" : "orphan_output",
      key: `${ANALYST_OUTPUT_DISPOSITION_KIND}:${input.task.id}`,
      evidence_ref: input.githubRefs[0] ?? input.task.id,
    },
    source_record_ref: {
      table: "tasks",
      id: input.task.id,
      field: "terminal_disposition",
    },
    task: {
      id: input.task.id,
      hiveId: input.task.hiveId,
      roleSlug: input.task.assignedTo,
    },
    evidence: {
      disposition: input.disposition,
      githubRefs: input.githubRefs,
      resultSummaryPresent: Boolean(input.resultSummary?.trim()),
    },
    safeguards: {
      canonicalDispositionRequired: true,
      routeOrNoFollowUpRecorded: true,
    },
  };
}

export function validateRoutingPublicationCompletion(input: {
  task: TaskDispositionContext;
  resultSummary: string;
  now?: Date;
}): { ok: true; disposition: AnalystOutputDisposition | null } | { ok: false; reason: string } {
  if (!isRoutingPublicationTask(input.task)) return { ok: true, disposition: null };

  const text = input.resultSummary;
  const canonical = findCanonicalOutputDisposition(text);
  if (!canonical) {
    return {
      ok: false,
      reason:
        "Routing/publication task completion rejected: result must record a GitHub issue/PR route or an explicit deliberate no-follow-up terminal disposition.",
    };
  }

  return {
    ok: true,
    disposition: buildAnalystOutputDisposition({
      task: input.task,
      resultSummary: input.resultSummary,
      disposition: canonical.disposition,
      githubRefs: canonical.githubRefs,
      now: input.now ?? new Date(),
      source: "dispatcher.completeTask.outputDisposition",
    }),
  };
}
