import type { Sql } from "postgres";
import { recordTaskLifecycleTransitionBestEffort } from "@/audit/task-lifecycle";

export const REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND = "reference_only_output";
export const REFERENCE_ONLY_WRAPPER_DISPOSITION_KIND = "reference_only_wrapper_superseded";

const REFERENCE_ONLY_INTENT_RE =
  /\b(reference[-\s]?only|proof[-\s]?only|report[-\s]?only|inventory|audit|review|scan|reconciliation|triage|findings? addressed|file[-\s]?referenced list|implementation[-\s]?ready matrix|implementation checklist|evidence|provenance)\b/i;

const IMPLEMENTATION_CUE_RE =
  /\b(fix|implement|update|add|remove|commit|apply|write|create|delete|migrate|stage|edit|change|land|harden|ship|deploy)\b/i;

const OWNER_ACTION_RE =
  /\b(owner|human|ea)\b.{0,60}\b(action|required|decision|approval|choose|choice|input|judg(?:e)?ment)\b|\b(action|required|decision|approval|choose|choice|input|judg(?:e)?ment)\b.{0,60}\b(owner|human|ea)\b/i;

const WRAPPER_CLEANUP_RE =
  /\b(orphan_output|unsatisfied_completion|reference[-\s]?only|cleanup|clean up|reconcile|wrapper|terminal(?:ize|ise)|already[-\s]?terminal|already attributable)\b/i;

export type ReferenceOnlyTerminalDisposition = {
  schemaVersion: 1;
  kind: typeof REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND;
  terminal: true;
  recordedAt: string;
  source: "supervisor.referenceOnlyTerminalDisposition";
  reason: string;
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
  source_disposition: ReferenceOnlyTerminalDisposition;
};

export interface ReferenceOnlyTerminalDispositionResult {
  scanned: number;
  disposed: number;
  wrappersScanned: number;
  wrappersSuperseded: number;
}

export function hasReferenceOnlyTerminalDisposition(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND && record.terminal === true;
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
  if (OWNER_ACTION_RE.test(text)) return false;
  return true;
}

export async function reconcileReferenceOnlyTerminalDispositions(
  sql: Sql,
  hiveId: string,
  input: { now?: Date; limit?: number } = {},
): Promise<ReferenceOnlyTerminalDispositionResult> {
  const now = input.now ?? new Date();
  const candidates = await loadReferenceOnlyCandidates(sql, hiveId, input.limit ?? 100);
  const result: ReferenceOnlyTerminalDispositionResult = {
    scanned: candidates.length,
    disposed: 0,
    wrappersScanned: 0,
    wrappersSuperseded: 0,
  };

  for (const task of candidates) {
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

function buildReferenceOnlyTerminalDisposition(
  task: ReferenceOnlyCandidateRow,
  now: Date,
): ReferenceOnlyTerminalDisposition {
  return {
    schemaVersion: 1,
    kind: REFERENCE_ONLY_TERMINAL_DISPOSITION_KIND,
    terminal: true,
    recordedAt: now.toISOString(),
    source: "supervisor.referenceOnlyTerminalDisposition",
    reason: "Reference-only output has durable task/hive/role-attributed work product evidence and no open owner action or active follow-up.",
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
  disposition: ReferenceOnlyTerminalDisposition,
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
  const disposition = {
    schemaVersion: 1,
    kind: REFERENCE_ONLY_WRAPPER_DISPOSITION_KIND,
    terminal: true,
    recordedAt: now.toISOString(),
    source: "supervisor.referenceOnlyTerminalDisposition.wrapper",
    reason: "Wrapper cleanup task superseded because the parent reference-only output already has a canonical terminal disposition.",
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
