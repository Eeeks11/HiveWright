import type { Sql, TransactionSql } from "postgres";
import type { OwnerOutcomeReviewState } from "@/db/schema/owner-outcomes";

type QuerySql = Sql | TransactionSql;

export type OwnerOutcomeReviewAction =
  | "accepted"
  | "needs_revision"
  | "archived"
  | "converted_to_process_candidate";

export interface ApplyOwnerOutcomeReviewActionInput {
  outcomeId: string;
  hiveId: string;
  action: OwnerOutcomeReviewAction;
  actorId: string;
  note?: string;
}

export interface ApplyOwnerOutcomeReviewActionResult {
  id: string;
  status: OwnerOutcomeReviewState;
  revisionTaskId?: string;
}

const VALID_ACTIONS = new Set<OwnerOutcomeReviewAction>([
  "accepted",
  "needs_revision",
  "archived",
  "converted_to_process_candidate",
]);

function compactText(value: string | undefined, maxLength: number): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}...` : text;
}

function assertRevisionNote(note: string | null) {
  if (!note) {
    throw new Error("A revision note is required before returning this output to the work queue.");
  }
}

function extractRevisionTaskId(metadata: Record<string, unknown>): string | undefined {
  const existing = metadata.reviewAction;
  if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    typeof (existing as { revisionTaskId?: unknown }).revisionTaskId === "string"
  ) {
    return (existing as { revisionTaskId: string }).revisionTaskId;
  }
  return undefined;
}

export function isOwnerOutcomeReviewAction(value: unknown): value is OwnerOutcomeReviewAction {
  return typeof value === "string" && VALID_ACTIONS.has(value as OwnerOutcomeReviewAction);
}

async function createRevisionFollowup(
  sql: QuerySql,
  outcome: {
    id: string;
    hive_id: string;
    goal_id: string;
    summary: string;
    primary_open_url: string | null;
    route_metadata: Record<string, unknown>;
  },
  actorId: string,
  note: string | null,
): Promise<string> {
  const existingRevisionTaskId = extractRevisionTaskId(outcome.route_metadata);
  if (existingRevisionTaskId) {
    const [task] = await sql<{ id: string }[]>`
      SELECT id
      FROM tasks
      WHERE id = ${existingRevisionTaskId}
        AND hive_id = ${outcome.hive_id}
      LIMIT 1
    `;
    if (task?.id) return task.id;
  }

  const boundedNote = note ?? "Owner requested revision without additional notes.";
  const brief = compactText([
    "Owner requested revision on a completed outcome handoff.",
    "",
    `Owner outcome: ${outcome.id}`,
    `Original summary: ${outcome.summary}`,
    outcome.primary_open_url ? `Primary output: ${outcome.primary_open_url}` : null,
    "",
    `Revision request: ${boundedNote}`,
    "",
    "Bounded path: review the completed handoff, update or replan only the needed outcome work, and leave existing process/policy state unchanged unless a separate owner-approved learning gate requires it.",
  ].filter((line): line is string => line !== null).join("\n"), 1800) as string;

  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (
      hive_id,
      assigned_to,
      created_by,
      title,
      brief,
      goal_id,
      status,
      priority,
      qa_required
    )
    VALUES (
      ${outcome.hive_id},
      'goal-supervisor',
      'owner',
      ${compactText(`[Outcome revision] ${outcome.summary}`, 500) ?? "[Outcome revision] Review completed handoff"},
      ${brief},
      ${outcome.goal_id},
      'pending',
      5,
      false
    )
    RETURNING id
  `;
  if (!task?.id) throw new Error("Failed to create owner outcome revision follow-up");

  await sql`
    UPDATE owner_outcomes
    SET route_metadata = COALESCE(route_metadata, '{}'::jsonb) ||
      ${sql.json({
        reviewAction: {
          action: "needs_revision",
          actorId,
          note: boundedNote,
          revisionTaskId: task.id,
          createdAt: new Date().toISOString(),
        },
      } as unknown as Parameters<typeof sql.json>[0])}::jsonb,
      updated_at = NOW()
    WHERE id = ${outcome.id}
  `;

  return task.id;
}

export async function applyOwnerOutcomeReviewAction(
  sql: Sql,
  input: ApplyOwnerOutcomeReviewActionInput,
): Promise<ApplyOwnerOutcomeReviewActionResult> {
  return await sql.begin(async (tx) => {
    const [outcome] = await tx<{
      id: string;
      hive_id: string;
      goal_id: string;
      summary: string;
      primary_open_url: string | null;
      route_metadata: Record<string, unknown>;
    }[]>`
      SELECT id, hive_id, goal_id, summary, primary_open_url, route_metadata
      FROM owner_outcomes
      WHERE id = ${input.outcomeId}
        AND hive_id = ${input.hiveId}
      FOR UPDATE
    `;
    if (!outcome) throw new Error("Owner outcome not found");

    const note = compactText(input.note, 700);
    const existingRevisionTaskId = extractRevisionTaskId(outcome.route_metadata);
    let revisionTaskId: string | undefined;
    let metadata: Record<string, unknown> = {
      reviewAction: {
        action: input.action,
        actorId: input.actorId,
        note,
        appliedAt: new Date().toISOString(),
        ...(existingRevisionTaskId ? { revisionTaskId: existingRevisionTaskId } : {}),
      },
    };

    if (input.action === "needs_revision") {
      assertRevisionNote(note);
      revisionTaskId = await createRevisionFollowup(tx, outcome, input.actorId, note);
      metadata = {
        ...metadata,
        reviewAction: {
          ...(metadata.reviewAction as Record<string, unknown>),
          revisionTaskId,
        },
      };
    }

    if (input.action === "converted_to_process_candidate") {
      metadata = {
        ...metadata,
        processCandidate: {
          status: "candidate_only",
          note,
          markedBy: input.actorId,
          markedAt: new Date().toISOString(),
        },
      };
    }

    const [updated] = await tx<{ id: string; review_state: OwnerOutcomeReviewState }[]>`
      UPDATE owner_outcomes
      SET review_state = ${input.action},
          reviewed_by = ${input.actorId},
          reviewed_at = NOW(),
          route_metadata = COALESCE(route_metadata, '{}'::jsonb) ||
            ${tx.json(metadata as unknown as Parameters<typeof tx.json>[0])}::jsonb,
          updated_at = NOW()
      WHERE id = ${input.outcomeId}
        AND hive_id = ${input.hiveId}
      RETURNING id, review_state
    `;
    if (!updated) throw new Error("Owner outcome not found");
    return { id: updated.id, status: updated.review_state, ...(revisionTaskId ? { revisionTaskId } : {}) };
  });
}
