import { sql } from "../../../../_lib/db";
import { requireApiUser } from "../../../../_lib/auth";
import { jsonError, jsonOk } from "../../../../_lib/responses";
import { canMutateHive } from "@/auth/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function expectedOwnerResponse(decision: "approved" | "rejected", reason: string) {
  return reason ? `${decision}: ${reason}` : decision;
}

function mapAsset(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    hiveId: row.hive_id as string,
    externalActionRequestId: (row.external_action_request_id as string | null) ?? null,
    externalActionDecisionId: (row.external_action_decision_id as string | null) ?? null,
    channel: row.channel as string,
    assetType: row.asset_type as string,
    title: row.title as string,
    draftBody: row.draft_body as string,
    approvalStatus: row.approval_status as string,
    publicationStatus: row.publication_status as string,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for as never).toISOString() : "",
  };
}

function isIdempotentDecision(
  row: Record<string, unknown>,
  decision: "approved" | "rejected",
  selectedOptionKey: "approve" | "reject",
  ownerResponse: string,
) {
  return row.decision_status === "resolved"
    && row.external_action_state === decision
    && row.approval_status === decision
    && row.selected_option_key === selectedOptionKey
    && row.owner_response === ownerResponse;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { assetId } = await context.params;
  if (!isUuid(assetId)) return jsonError("assetId must be a UUID", 400);

  try {
    const body = await request.json();
    const decision = body.decision;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (decision !== "approved" && decision !== "rejected") {
      return jsonError("decision must be approved or rejected", 400);
    }

    const existingRows = await sql`
      SELECT ma.id, ma.hive_id, ma.campaign_id, ma.external_action_request_id,
             ma.approval_status, ma.publication_status, ma.channel, ma.asset_type,
             ma.title, ma.draft_body, ma.scheduled_for,
             ear.decision_id AS external_action_decision_id, ear.state AS external_action_state,
             d.kind AS decision_kind, d.status AS decision_status, d.owner_response, d.selected_option_key
      FROM marketing_assets ma
      JOIN external_action_requests ear ON ear.id = ma.external_action_request_id AND ear.hive_id = ma.hive_id
      JOIN decisions d ON d.id = ear.decision_id AND d.hive_id = ma.hive_id
      WHERE ma.id = ${assetId}
      LIMIT 1
    `;
    const existing = (existingRows as unknown as Record<string, unknown>[])[0];
    if (!existing) return jsonError("Marketing asset approval request not found", 404);
    const hiveId = existing.hive_id as string;
    if (!authz.user.isSystemOwner && !(await canMutateHive(sql, authz.user.id, hiveId))) {
      return jsonError("Forbidden: caller cannot approve external actions for this hive", 403);
    }
    if (existing.decision_kind !== "external_action_approval") {
      return jsonError("Marketing asset is not linked to an external action approval decision", 409);
    }

    const selectedOptionKey = decision === "approved" ? "approve" : "reject";
    const selectedOptionLabel = decision === "approved" ? "Approve" : "Reject";
    const ownerResponse = expectedOwnerResponse(decision, reason);

    if (existing.decision_status === "resolved") {
      if (isIdempotentDecision(existing, decision, selectedOptionKey, ownerResponse)) {
        return jsonOk({ asset: mapAsset(existing) });
      }
      return jsonError("Marketing asset approval decision is already resolved", 409);
    }
    if (existing.external_action_state !== "awaiting_approval") {
      return jsonError("Marketing external action request is not awaiting owner approval", 409);
    }

    const assetRows = await sql.begin(async (tx) => {
      const lockedRows = await tx`
        SELECT ma.id, ma.hive_id, ma.campaign_id, ma.external_action_request_id, ma.approval_status,
               ear.decision_id AS external_action_decision_id, ear.state AS external_action_state,
               d.kind AS decision_kind, d.status AS decision_status
        FROM marketing_assets ma
        JOIN external_action_requests ear ON ear.id = ma.external_action_request_id AND ear.hive_id = ma.hive_id
        JOIN decisions d ON d.id = ear.decision_id AND d.hive_id = ma.hive_id
        WHERE ma.id = ${assetId}
          AND ma.hive_id = ${hiveId}
        FOR UPDATE OF ma, ear, d
      `;
      const locked = (lockedRows as unknown as Record<string, unknown>[])[0];
      if (!locked) throw new ConflictError("Marketing asset approval request changed during decision recording");
      if (locked.decision_kind !== "external_action_approval" || locked.decision_status !== "pending" || locked.external_action_state !== "awaiting_approval") {
        throw new ConflictError("Marketing asset approval request is no longer awaiting owner approval");
      }

      const decisionRows = await tx`
        UPDATE decisions
        SET status = 'resolved', owner_response = ${ownerResponse},
            selected_option_key = ${selectedOptionKey}, selected_option_label = ${selectedOptionLabel},
            resolved_by = ${authz.user.id}, resolved_at = now()
        WHERE id = ${locked.external_action_decision_id as string}
          AND hive_id = ${hiveId}
          AND kind = 'external_action_approval'
          AND status <> 'resolved'
        RETURNING id
      `;
      if ((decisionRows as unknown[]).length !== 1) {
        throw new ConflictError("Marketing asset approval decision could not be recorded");
      }

      const requestRows = await tx`
        UPDATE external_action_requests
        SET state = ${decision}, reviewed_by = ${authz.user.id}, reviewed_at = now(),
            error_message = ${decision === "rejected" ? reason || "owner rejected marketing asset" : null}, updated_at = now()
        WHERE id = ${locked.external_action_request_id as string}
          AND hive_id = ${hiveId}
          AND decision_id = ${locked.external_action_decision_id as string}
          AND state = 'awaiting_approval'
        RETURNING id, state, reviewed_by
      `;
      if ((requestRows as unknown[]).length !== 1) {
        throw new ConflictError("Marketing external action request could not be finalized");
      }

      const rows = await tx`
        UPDATE marketing_assets
        SET approval_status = ${decision},
            publication_status = ${decision === "approved" ? "queued" : "blocked"},
            updated_at = now()
        WHERE id = ${assetId}
          AND hive_id = ${hiveId}
          AND approval_status = 'pending_owner_approval'
        RETURNING id, hive_id, campaign_id, external_action_request_id,
                  ${locked.external_action_decision_id as string} AS external_action_decision_id,
                  channel, asset_type, title, draft_body, approval_status, publication_status, scheduled_for
      `;
      if ((rows as unknown[]).length !== 1) {
        throw new ConflictError("Marketing asset approval state could not be finalized");
      }

      if (decision === "approved") {
        const campaignRows = await tx`
          UPDATE marketing_campaigns
          SET status = 'approved', updated_at = now()
          WHERE id = ${locked.campaign_id as string}
            AND hive_id = ${hiveId}
            AND status IN ('idea', 'draft', 'approval', 'approved')
          RETURNING id
        `;
        if ((campaignRows as unknown[]).length !== 1) {
          throw new ConflictError("Marketing campaign approval state could not be finalized");
        }
      }

      return rows;
    });

    return jsonOk({ asset: mapAsset((assetRows as unknown as Record<string, unknown>[])[0]) });
  } catch (error) {
    if (error instanceof ConflictError) return jsonError(error.message, 409);
    return jsonError("Failed to record marketing asset decision", 500);
  }
}
