import { canMutateHive } from "@/auth/users";
import {
  applyOwnerOutcomeReviewAction,
  isOwnerOutcomeReviewAction,
} from "@/outcomes/review-actions";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReviewBody = {
  action?: unknown;
  note?: unknown;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  const { id } = await params;

  if (!UUID_RE.test(id)) return jsonError("outcome id must be a valid UUID", 400);

  let body: ReviewBody;
  try {
    body = (await request.json()) as ReviewBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!isOwnerOutcomeReviewAction(body.action)) {
    return jsonError("action must be accepted, needs_revision, archived, or converted_to_process_candidate", 400);
  }
  if (body.note !== undefined && typeof body.note !== "string") {
    return jsonError("note must be a string when provided", 400);
  }

  const [outcome] = await sql<{ hive_id: string }[]>`
    SELECT hive_id
    FROM owner_outcomes
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!outcome) return jsonError("Owner outcome not found", 404);

  if (!user.isSystemOwner) {
    const canMutate = await canMutateHive(sql, user.id, outcome.hive_id);
    if (!canMutate) {
      return jsonError("Forbidden: caller cannot review outcomes for this hive", 403);
    }
  }

  const result = await applyOwnerOutcomeReviewAction(sql, {
    outcomeId: id,
    hiveId: outcome.hive_id,
    action: body.action,
    actorId: user.id,
    note: typeof body.note === "string" ? body.note : undefined,
  });

  return jsonOk(result);
}
