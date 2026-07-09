import type { Sql } from "postgres";
import { recordTaskLifecycleTransitionBestEffort } from "@/audit/task-lifecycle";
import type {
  ClosureScope,
  DecisionBoundary,
  FinalDispositionLabel,
  StorageRootFamily,
  TerminalStatus,
} from "@/closeout/registry";
import { resolveTerminalDispositionCompatibility } from "@/closeout/registry";
import { resolveHiveWrightBuildProvenance } from "@/diagnostics/build-provenance";
import {
  validateImprovementScanPublicationEvidence,
  type ImprovementScanEndpointEvidence,
  type ImprovementScanEndpointFamily,
  type ImprovementScanFindingAction,
  type ImprovementScanPromotedFindingEvidence,
} from "@/operations/improvement-scan-evidence";
import {
  ANALYST_OUTPUT_DISPOSITION_KIND,
  buildAnalystOutputDisposition,
  findCanonicalOutputDisposition,
  isAnalystOutputTask,
  isRoutingPublicationTask,
} from "@/tasks/output-disposition";

export const REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND = "reference_only_output";
export const REFERENCE_ONLY_WRAPPER_DISPOSITION_KIND = "reference_only_wrapper_superseded";
export const IMPROVEMENT_SCAN_BACKLOG_DISPOSITION_KIND = "improvement_scan_backlog_disposition";

const REFERENCE_ONLY_INTENT_RE =
  /\b(reference[-\s]?only|proof[-\s]?only|report[-\s]?only|inventory|audit|review|scan|reconciliation|triage|findings? addressed|file[-\s]?referenced list|implementation[-\s]?ready matrix|implementation checklist|evidence|provenance)\b/i;

const IMPLEMENTATION_CUE_RE =
  /\b(fix|implement|update|add|remove|commit|apply|write|create|delete|migrate|stage|edit|change|land|harden|ship|deploy)\b/i;

const OWNER_ACTION_RE =
  /\b(owner|human|ea)\b.{0,60}\b(action|required|decision|approval|choose|choice|input|judg(?:e)?ment)\b|\b(action|required|decision|approval|choose|choice|input|judg(?:e)?ment)\b.{0,60}\b(owner|human|ea)\b/i;
const NO_OWNER_ACTION_REQUIRED_RE =
  /\bno\s+(?:new\s+)?(?:owner|human|ea)\s+(?:action|decision|approval|input)\s+(?:is\s+)?required\b|\bowner_action_required\s*:\s*no_new_decision\b/i;

const WRAPPER_CLEANUP_RE =
  /\b(orphan_output|unsatisfied_completion|reference[-\s]?only|cleanup|clean up|reconcile|wrapper|terminal(?:ize|ise)|already[-\s]?terminal|already attributable)\b/i;

const IMPROVEMENT_SCAN_RE =
  /\b(?:hivewright\s+)?improvement[-\s]?scan\b|\bproposal[-\s]?routing\b|\bquality[-\s]?feedback[-\s]?sample[-\s]?review\b/i;
const GOVERNED_SCAN_DISPOSITION_RE =
  /\bno[-\s]?action\b|\bno\s+new\s+decision\b|\bterminal\s+closeout\b|\balready[-\s]?(?:routed|governed|covered|tracked)\b|\bexisting\s+(?:github\s+)?(?:issue|pr|pull request)\b|\bgithub\s+(?:issue|pr)\s*#?\d+\b|\b(?:issue|pr)\s*#\d+\b|https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+/i;

export type ReferenceOnlyTerminalDisposition = {
  schemaVersion: 1;
  kind: typeof REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND;
  terminal: true;
  recordedAt: string;
  source: "supervisor.referenceOnlyTerminalDisposition";
  reason: string;
  terminal_status: TerminalStatus;
  final_disposition_label: FinalDispositionLabel;
  closure_scope: ClosureScope;
  decision_boundary: DecisionBoundary;
  storage_root_family: StorageRootFamily;
  source_finding: {
    kind: "orphan_output";
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
    workProductIds: string[];
    workProductCount: number;
    attribution: "task_hive_role_match";
  };
  safeguards: {
    noOpenOwnerAction: true;
    noActiveFollowUp: true;
    noFailureReason: true;
    noImplementationCue: true;
  };
};

type ReferenceOnlyCandidateRow = {
  id: string;
  hive_id: string;
  assigned_to: string;
  title: string;
  brief: string | null;
  result_summary: string | null;
  work_product_text: string | null;
  work_product_ids: string[];
};

type WrapperCandidateRow = {
  id: string;
  hive_id: string;
  goal_id: string | null;
  status: string;
  title: string;
  brief: string | null;
  parent_task_id: string;
  source_disposition: { kind: string };
};

export interface ReferenceOnlyTerminalDispositionResult {
  scanned: number;
  disposed: number;
  wrappersScanned: number;
  wrappersSuperseded: number;
  improvementScansBlockedByEvidenceGate: number;
}

export function hasReferenceOnlyTerminalDisposition(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND && record.terminal === true;
}

export function hasSupervisorManagedTerminalDisposition(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.terminal === true && (
    record.kind === REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND ||
    record.kind === IMPROVEMENT_SCAN_BACKLOG_DISPOSITION_KIND ||
    record.kind === ANALYST_OUTPUT_DISPOSITION_KIND
  );
}

export function isReferenceOnlyTerminalCandidateText(input: {
  title: string | null;
  brief: string | null;
  resultSummary: string | null;
}): boolean {
  const text = [input.title ?? "", input.brief ?? "", input.resultSummary ?? ""]
    .join("\n")
    .trim();
  if (!text) return false;
  if (!REFERENCE_ONLY_INTENT_RE.test(text)) return false;
  if (IMPLEMENTATION_CUE_RE.test(text)) return false;
  if (OWNER_ACTION_RE.test(text) && !NO_OWNER_ACTION_REQUIRED_RE.test(text)) return false;
  return true;
}

export function isGovernedImprovementScanTerminalCandidateText(input: {
  title: string | null;
  brief: string | null;
  resultSummary: string | null;
  workProductText: string | null;
}): boolean {
  const text = [
    input.title ?? "",
    input.brief ?? "",
    input.resultSummary ?? "",
    input.workProductText ?? "",
  ].join("\n").trim();
  if (!text) return false;
  if (!IMPROVEMENT_SCAN_RE.test(text)) return false;
  if (!GOVERNED_SCAN_DISPOSITION_RE.test(text)) return false;
  if (OWNER_ACTION_RE.test(text) && !NO_OWNER_ACTION_REQUIRED_RE.test(text)) return false;
  return true;
}

export async function reconcileReferenceOnlyTerminalDispositions(
  sql: Sql,
  hiveId: string,
  input: {
    now?: Date;
    limit?: number;
    publicationBuildHash?: string | null;
    env?: NodeJS.ProcessEnv;
    repoRoot?: string;
  } = {},
): Promise<ReferenceOnlyTerminalDispositionResult> {
  const now = input.now ?? new Date();
  const candidates = await loadReferenceOnlyCandidates(sql, hiveId, input.limit ?? 100);
  const result: ReferenceOnlyTerminalDispositionResult = {
    scanned: candidates.length,
    disposed: 0,
    wrappersScanned: 0,
    wrappersSuperseded: 0,
    improvementScansBlockedByEvidenceGate: 0,
  };
  let currentPublicationBuildHash: string | null | undefined = input.publicationBuildHash;

  for (const task of candidates) {
    if (isGovernedImprovementScanTerminalCandidateText({
      title: task.title,
      brief: task.brief,
      resultSummary: task.result_summary,
      workProductText: task.work_product_text,
    })) {
      if (currentPublicationBuildHash === undefined) {
        currentPublicationBuildHash = resolveHiveWrightBuildProvenance({
          env: input.env,
          now,
          repoRoot: input.repoRoot,
        }).buildHash;
      }
      const evidenceGate = validateImprovementScanPublicationEvidence({
        publicationBuildHash: currentPublicationBuildHash,
        promotedFindings: extractImprovementScanPromotedFindings(task),
      });
      if (!evidenceGate.ok) {
        result.improvementScansBlockedByEvidenceGate += 1;
        continue;
      }

      const disposition = buildImprovementScanBacklogDisposition(task, now, evidenceGate);
      await persistReferenceOnlyDisposition(sql, task.id, disposition);
      result.disposed += 1;
      continue;
    }

    const analystText = [task.title, task.brief, task.result_summary, task.work_product_text]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    const analystDisposition = isAnalystOutputTask({
      assignedTo: task.assigned_to,
      title: task.title,
      brief: task.brief,
    })
      ? findCanonicalOutputDisposition(analystText)
      : null;
    if (analystDisposition) {
      await persistReferenceOnlyDisposition(sql, task.id, buildAnalystOutputDisposition({
        task: {
          id: task.id,
          hiveId: task.hive_id,
          assignedTo: task.assigned_to,
          title: task.title,
          brief: task.brief,
        },
        resultSummary: task.result_summary,
        disposition: analystDisposition.disposition,
        githubRefs: analystDisposition.githubRefs,
        now,
        source: "supervisor.referenceOnlyTerminalDisposition.analystOutput",
      }));
      result.disposed += 1;
      continue;
    }

    if (isRoutingPublicationTask({
      assignedTo: task.assigned_to,
      title: task.title,
      brief: task.brief,
    })) continue;

    if (!isReferenceOnlyTerminalCandidateText({
      title: task.title,
      brief: task.brief,
      resultSummary: task.result_summary,
    })) continue;

    const disposition = buildReferenceOnlyTerminalDisposition(task, now);
    await persistReferenceOnlyDisposition(sql, task.id, disposition);
    result.disposed += 1;
  }

  const wrappers = (await loadWrapperCandidates(sql, hiveId, input.limit ?? 100))
    .filter((wrapper) => WRAPPER_CLEANUP_RE.test(`${wrapper.title}\n${wrapper.brief ?? ""}`));
  result.wrappersScanned = wrappers.length;
  for (const wrapper of wrappers) {
    await markWrapperSuperseded(sql, wrapper, now);
    result.wrappersSuperseded += 1;
  }

  return result;
}

async function loadReferenceOnlyCandidates(
  sql: Sql,
  hiveId: string,
  limit: number,
): Promise<ReferenceOnlyCandidateRow[]> {
  return sql<ReferenceOnlyCandidateRow[]>`
    SELECT
      t.id,
      t.hive_id,
      t.assigned_to,
      t.title,
      t.brief,
      t.result_summary,
      string_agg(
        concat_ws(E'\n', wp.title, wp.summary, left(wp.content, 2000), wp.public_url, wp.source_url),
        E'\n---\n' ORDER BY wp.created_at, wp.id
      ) AS work_product_text,
      array_agg(wp.id::text ORDER BY wp.created_at, wp.id) AS work_product_ids
    FROM tasks t
    JOIN work_products wp
      ON wp.task_id = t.id
     AND wp.hive_id = t.hive_id
     AND wp.role_slug = t.assigned_to
    WHERE t.hive_id = ${hiveId}::uuid
      AND t.status = 'completed'
      AND t.failure_reason IS NULL
      AND t.terminal_disposition IS NULL
      AND t.completed_at IS NOT NULL
      AND t.completed_at > NOW() - interval '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM decisions d
        WHERE d.task_id = t.id
          AND d.status IN ('pending', 'ea_review')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks child
        WHERE child.parent_task_id = t.id
          AND child.status IN ('pending', 'active', 'claimed', 'running', 'blocked', 'in_review')
      )
      AND NOT EXISTS (
        SELECT 1 FROM work_products missing
        WHERE missing.task_id = t.id
          AND missing.hive_id = t.hive_id
          AND missing.role_slug = t.assigned_to
          AND COALESCE(NULLIF(missing.content, ''), missing.file_path, missing.public_url, missing.source_url) IS NULL
      )
    GROUP BY t.id, t.hive_id, t.assigned_to, t.title, t.brief, t.result_summary
    ORDER BY t.completed_at ASC, t.created_at ASC
    LIMIT ${limit}
  `;
}

function buildImprovementScanBacklogDisposition(
  task: ReferenceOnlyCandidateRow,
  now: Date,
  evidenceGate: ReturnType<typeof validateImprovementScanPublicationEvidence>,
) {
  const compatibility = resolveTerminalDispositionCompatibility(IMPROVEMENT_SCAN_BACKLOG_DISPOSITION_KIND);
  const text = [task.title, task.brief, task.result_summary, task.work_product_text]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const githubRefs = Array.from(new Set([
    ...Array.from(text.matchAll(/https:\/\/github\.com\/[^\s)]+\/(?:issues|pull)\/\d+/gi)),
    ...Array.from(text.matchAll(/\b(?:github\s+)?(?:issue|pr)\s*#?\d+\b/gi)),
    ...Array.from(text.matchAll(/(?<![\w/])#\d+\b/g)),
  ].map((match) => match[0]))).slice(0, 10);

  return {
    schemaVersion: 1,
    kind: IMPROVEMENT_SCAN_BACKLOG_DISPOSITION_KIND,
    terminal: true,
    recordedAt: now.toISOString(),
    source: "supervisor.referenceOnlyTerminalDisposition.improvementScan",
    reason: githubRefs.length > 0
      ? "Improvement scan is already attached to a downstream GitHub issue/PR/backlog route and has durable work product evidence."
      : "Improvement scan records an explicit bounded no-action/terminal closeout disposition with durable work product evidence.",
    terminal_status: githubRefs.length > 0 ? compatibility.terminalStatus : "closed",
    final_disposition_label: githubRefs.length > 0
      ? compatibility.finalDispositionLabel ?? "github_issue_backlog_open"
      : "reference_only_output",
    closure_scope: githubRefs.length > 0 ? compatibility.closureScope : "task",
    decision_boundary: compatibility.decisionBoundary,
    storage_root_family: compatibility.storageRootFamily,
    source_finding: {
      kind: "unsatisfied_completion" as const,
      key: `improvement_scan_backlog_disposition:${task.id}`,
      evidence_ref: task.work_product_ids[0] ?? task.id,
    },
    source_record_ref: {
      table: "tasks",
      id: task.id,
      field: "terminal_disposition",
    },
    task: {
      id: task.id,
      hiveId: task.hive_id,
      roleSlug: task.assigned_to,
    },
    evidence: {
      workProductIds: task.work_product_ids,
      workProductCount: task.work_product_ids.length,
      githubRefs,
      disposition: githubRefs.length > 0 ? "already_routed" : "explicit_no_action",
      publicationEvidenceGate: {
        ok: evidenceGate.ok,
        blockedFindingIds: evidenceGate.blockedFindingIds,
        reasons: evidenceGate.reasons,
      },
    },
    safeguards: {
      noOpenOwnerAction: true,
      noActiveFollowUp: true,
      noFailureReason: true,
      durableEvidencePresent: true,
    },
  };
}

function extractImprovementScanPromotedFindings(
  task: ReferenceOnlyCandidateRow,
): ImprovementScanPromotedFindingEvidence[] {
  const text = [task.title, task.brief, task.result_summary, task.work_product_text]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    const findings = coercePromotedFindings(candidate);
    if (findings.length > 0) return findings;
  }
  return [];
}

function extractJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = parseJson(match[1]);
    if (parsed !== undefined) candidates.push(parsed);
  }

  const markerMatch = text.match(/improvementScanEvidence\s*[:=]\s*(\{[\s\S]*\}|\[[\s\S]*\])/i);
  if (markerMatch) {
    const parsed = parseJson(markerMatch[1]);
    if (parsed !== undefined) candidates.push(parsed);
  }

  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    const parsed = parseJson(trimmed);
    if (parsed !== undefined) candidates.push(parsed);
  }
  return candidates;
}

function parseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function coercePromotedFindings(value: unknown): ImprovementScanPromotedFindingEvidence[] {
  if (Array.isArray(value)) return value.flatMap(coercePromotedFinding);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const promotedFindings = record.promotedFindings ?? record.findings;
  if (Array.isArray(promotedFindings)) return promotedFindings.flatMap(coercePromotedFinding);
  if (record.improvementScanEvidence && typeof record.improvementScanEvidence === "object") {
    return coercePromotedFindings(record.improvementScanEvidence);
  }
  return coercePromotedFinding(record);
}

function coercePromotedFinding(value: unknown): ImprovementScanPromotedFindingEvidence[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const findingId = typeof record.findingId === "string" ? record.findingId : typeof record.id === "string" ? record.id : null;
  const endpointFamily = isEndpointFamily(record.endpointFamily) ? record.endpointFamily : null;
  const actions = Array.isArray(record.actions)
    ? record.actions.filter(isFindingAction)
    : typeof record.action === "string" && isFindingAction(record.action)
      ? [record.action]
      : [];
  const rawEvidence = Array.isArray(record.endpointEvidence)
    ? record.endpointEvidence
    : Array.isArray(record.evidence)
      ? record.evidence
      : [];
  const endpointEvidence = rawEvidence.flatMap(coerceEndpointEvidence);

  if (!findingId || !endpointFamily || actions.length === 0 || endpointEvidence.length === 0) return [];
  return [{ findingId, actions, endpointFamily, endpointEvidence }];
}

function coerceEndpointEvidence(value: unknown): ImprovementScanEndpointEvidence[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (typeof record.endpoint !== "string" || typeof record.checkedAt !== "string") return [];
  if (record.buildHash !== null && typeof record.buildHash !== "string") return [];
  const authoritativeFor = Array.isArray(record.authoritativeFor)
    ? record.authoritativeFor.filter(isEndpointFamily)
    : [];
  if (authoritativeFor.length === 0) return [];
  return [{
    endpoint: record.endpoint,
    checkedAt: record.checkedAt,
    buildHash: record.buildHash,
    authoritativeFor,
  }];
}

function isEndpointFamily(value: unknown): value is ImprovementScanEndpointFamily {
  return typeof value === "string" && [
    "readiness",
    "model_routing",
    "runtime_drift",
    "setup_runtime",
    "security",
    "performance",
    "other",
  ].includes(value);
}

function isFindingAction(value: unknown): value is ImprovementScanFindingAction {
  return typeof value === "string" && ["publish", "route_issue", "reopen_issue", "close_issue"].includes(value);
}

function buildReferenceOnlyTerminalDisposition(
  task: ReferenceOnlyCandidateRow,
  now: Date,
): ReferenceOnlyTerminalDisposition {
  const compatibility = resolveTerminalDispositionCompatibility(REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND);

  return {
    schemaVersion: 1,
    kind: REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND,
    terminal: true,
    recordedAt: now.toISOString(),
    source: "supervisor.referenceOnlyTerminalDisposition",
    reason: "Reference-only output has durable task/hive/role-attributed work product evidence and no open owner action or active follow-up.",
    terminal_status: compatibility.terminalStatus,
    final_disposition_label: compatibility.finalDispositionLabel ?? REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND,
    closure_scope: compatibility.closureScope,
    decision_boundary: compatibility.decisionBoundary,
    storage_root_family: compatibility.storageRootFamily,
    source_finding: {
      kind: "orphan_output",
      key: `reference_only_output:${task.id}`,
      evidence_ref: task.work_product_ids[0] ?? task.id,
    },
    source_record_ref: {
      table: "tasks",
      id: task.id,
      field: "terminal_disposition",
    },
    task: {
      id: task.id,
      hiveId: task.hive_id,
      roleSlug: task.assigned_to,
    },
    evidence: {
      workProductIds: task.work_product_ids,
      workProductCount: task.work_product_ids.length,
      attribution: "task_hive_role_match",
    },
    safeguards: {
      noOpenOwnerAction: true,
      noActiveFollowUp: true,
      noFailureReason: true,
      noImplementationCue: true,
    },
  };
}

async function persistReferenceOnlyDisposition(
  sql: Sql,
  taskId: string,
  disposition: Parameters<typeof sql.json>[0],
): Promise<void> {
  await sql`
    UPDATE tasks
    SET terminal_disposition = ${sql.json(disposition)},
        updated_at = NOW()
    WHERE id = ${taskId}
      AND terminal_disposition IS NULL
  `;
}

async function loadWrapperCandidates(
  sql: Sql,
  hiveId: string,
  limit: number,
): Promise<WrapperCandidateRow[]> {
  return sql<WrapperCandidateRow[]>`
    SELECT
      w.id,
      w.hive_id,
      w.goal_id,
      w.status,
      w.title,
      w.brief,
      w.parent_task_id,
      src.terminal_disposition AS source_disposition
    FROM tasks w
    JOIN tasks src
      ON src.id = w.parent_task_id
     AND src.hive_id = w.hive_id
    WHERE w.hive_id = ${hiveId}::uuid
      AND w.status IN ('pending', 'blocked', 'in_review')
      AND src.terminal_disposition ->> 'kind' = ${REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND}
      AND src.terminal_disposition ->> 'terminal' = 'true'
      AND NOT EXISTS (
        SELECT 1 FROM decisions d
        WHERE d.task_id = w.id
          AND d.status IN ('pending', 'ea_review')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks child
        WHERE child.parent_task_id = w.id
          AND child.status IN ('pending', 'active', 'claimed', 'running', 'blocked', 'in_review')
      )
    ORDER BY w.updated_at ASC, w.created_at ASC
    LIMIT ${limit}
  `;
}

async function markWrapperSuperseded(
  sql: Sql,
  wrapper: WrapperCandidateRow,
  now: Date,
): Promise<void> {
  const compatibility = resolveTerminalDispositionCompatibility(REFERENCE_ONLY_WRAPPER_DISPOSITION_KIND);
  const disposition = {
    schemaVersion: 1,
    kind: REFERENCE_ONLY_WRAPPER_DISPOSITION_KIND,
    terminal: true,
    recordedAt: now.toISOString(),
    source: "supervisor.referenceOnlyTerminalDisposition.wrapper",
    reason: "Wrapper cleanup task superseded because the parent reference-only output already has a canonical terminal disposition.",
    terminal_status: compatibility.terminalStatus,
    final_disposition_label: compatibility.finalDispositionLabel ?? REFERENCE_ONLY_WRAPPER_DISPOSITION_KIND,
    closure_scope: compatibility.closureScope,
    decision_boundary: compatibility.decisionBoundary,
    storage_root_family: compatibility.storageRootFamily,
    source_finding: {
      kind: "orphan_output",
      key: `reference_only_wrapper_superseded:${wrapper.id}`,
      evidence_ref: wrapper.parent_task_id,
    },
    source_record_ref: {
      table: "tasks",
      id: wrapper.id,
      field: "terminal_disposition",
    },
    task: {
      id: wrapper.id,
      hiveId: wrapper.hive_id,
    },
    links: {
      sourceTaskId: wrapper.parent_task_id,
      sourceDispositionKind: wrapper.source_disposition.kind,
    },
  };

  const [updated] = await sql<{ status: string }[]>`
    UPDATE tasks
    SET status = 'superseded',
        result_summary = COALESCE(
          result_summary || E'\n\n' || ${"[hive-supervisor] superseded: parent reference-only output is already durably terminal."},
          ${"[hive-supervisor] superseded: parent reference-only output is already durably terminal."}
        ),
        terminal_disposition = ${sql.json(disposition)},
        updated_at = NOW()
    WHERE id = ${wrapper.id}
      AND status = ${wrapper.status}
    RETURNING status
  `;

  await recordTaskLifecycleTransitionBestEffort(sql, {
    taskId: wrapper.id,
    hiveId: wrapper.hive_id,
    goalId: wrapper.goal_id,
    previousStatus: wrapper.status,
    nextStatus: updated?.status ?? "superseded",
    source: "supervisor.referenceOnlyTerminalDisposition.wrapper",
    reason: "Superseded stale wrapper for already-terminal reference-only output.",
  });
}
