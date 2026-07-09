import type {
  ClosureScope,
  DecisionBoundary,
  FinalDispositionLabel,
  StorageRootFamily,
  TerminalStatus,
} from "@/closeout/registry";

export const ANALYST_OUTPUT_DISPOSITION_KIND = "analyst_output_disposition";

const GITHUB_ROUTE_RE =
  /https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+|\bgithub\s+(?:issue|pr|pull request)\s*#?\d+\b|\b(?:issue|pr|pull request)\s*#\d+\b|(?<![\w/])#\d+\b/gi;

const DELIBERATE_NO_FOLLOW_UP_RE =
  /\b(?:deliberate|explicit|intentional|accepted|bounded|terminal)\b.{0,80}\b(?:no[-\s]?follow[-\s]?up|no\s+follow\s+up|no[-\s]?action|no\s+new\s+(?:issue|pr|decision|follow[-\s]?up)|terminal\s+closeout|no\s+further\s+action)\b|\b(?:no[-\s]?follow[-\s]?up|no\s+follow\s+up|no[-\s]?action|no\s+new\s+(?:issue|pr|decision|follow[-\s]?up)|terminal\s+closeout|no\s+further\s+action)\b.{0,80}\b(?:deliberate|explicit|intentional|accepted|bounded|terminal|recorded)\b/i;

const NEGATED_CANONICAL_DISPOSITION_RE =
  /\b(?:no|without|missing)\b.{0,80}\b(?:github\s+)?(?:issue|pr|pull request|route|routing|terminal\s+disposition|no[-\s]?follow[-\s]?up\s+disposition)\b.{0,80}\b(?:recorded|published|created|opened|filed|linked)\b/i;

const ROUTING_PUBLICATION_TASK_RE =
  /\b(?:route|routing|publish|publication|promote|promotion|open|create|file)\b.{0,90}\b(?:github|issue|pr|pull request|backlog)\b|\b(?:github|issue|pr|pull request|backlog)\b.{0,90}\b(?:route|routing|publish|publication|promote|promotion|open|create|file)\b|\bprior\s+findings?\b.{0,90}\b(?:github|issue|pr|pull request|publish|route|routing)\b/i;

const ANALYST_OUTPUT_ROLE_RE =
  /(?:^|[-_])(analyst|auditor|coordinator)(?:$|[-_])|^(?:performance-analyst|research-analyst|system-health-auditor|operations-coordinator)$/i;

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

export function extractGithubRouteRefs(text: string): string[] {
  GITHUB_ROUTE_RE.lastIndex = 0;
  return Array.from(new Set(Array.from(text.matchAll(GITHUB_ROUTE_RE)).map((match) => match[0]))).slice(0, 10);
}

export function hasDeliberateNoFollowUpDisposition(text: string): boolean {
  return DELIBERATE_NO_FOLLOW_UP_RE.test(text);
}

export function isRoutingPublicationTask(input: Pick<TaskDispositionContext, "assignedTo" | "title" | "brief">): boolean {
  const text = [input.assignedTo, input.title, input.brief ?? ""].join("\n");
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

  const text = [input.task.title, input.task.brief ?? "", input.resultSummary].join("\n");
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
