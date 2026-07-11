import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { jsonError, jsonOk } from "../../_lib/responses";
import { canMutateHive } from "@/auth/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_CONNECTORS = new Set(["manual", "manual_import", "connector"]);

class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function mapExecutionLog(row: Record<string, unknown>) {
  return {
    id: row.id,
    hiveId: row.hive_id,
    campaignId: row.campaign_id,
    assetId: row.asset_id,
    externalActionRequestId: row.external_action_request_id,
    action: row.action,
    connector: row.connector,
    executedAt: new Date(row.executed_at as never).toISOString(),
    trace: row.trace,
  };
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json();
    const assetId = body.assetId;
    const action = typeof body.action === "string" ? body.action.trim() : "";
    const connector = typeof body.connector === "string" && ALLOWED_CONNECTORS.has(body.connector)
      ? body.connector
      : "manual_import";
    if (!isUuid(assetId) || !action) return jsonError("assetId UUID and action are required", 400);
    if (action.length > 128) return jsonError("action must be 128 characters or fewer", 400);

    const assetRows = await sql`
      SELECT ma.id, ma.hive_id, ma.campaign_id, ma.external_action_request_id, ma.approval_status,
             ear.decision_id AS external_action_decision_id, ear.state AS external_action_state,
             d.status AS decision_status, d.selected_option_key
      FROM marketing_assets ma
      JOIN external_action_requests ear ON ear.id = ma.external_action_request_id AND ear.hive_id = ma.hive_id
      JOIN decisions d ON d.id = ear.decision_id AND d.hive_id = ma.hive_id
      WHERE ma.id = ${assetId}
      LIMIT 1
    `;
    const asset = (assetRows as unknown as Record<string, unknown>[])[0];
    if (!asset) return jsonError("Marketing asset approval request not found", 404);
    const hiveId = asset.hive_id as string;
    if (!authz.user.isSystemOwner && !(await canMutateHive(sql, authz.user.id, hiveId))) {
      return jsonError("Forbidden: caller cannot manage this hive", 403);
    }
    if (asset.approval_status !== "approved" || asset.decision_status !== "resolved" || asset.selected_option_key !== "approve") {
      return jsonError("Marketing execution requires owner approval", 409);
    }
    if (asset.external_action_state !== "approved" && asset.external_action_state !== "succeeded") {
      return jsonError("Marketing external action request is not approved for execution", 409);
    }

    const result = await sql.begin(async (tx) => {
      const existingLogs = await tx`
        SELECT id, hive_id, campaign_id, asset_id, external_action_request_id, action, connector, executed_at, trace
        FROM marketing_execution_logs
        WHERE hive_id = ${hiveId}
          AND asset_id = ${assetId}
          AND external_action_request_id = ${asset.external_action_request_id as string}
        ORDER BY executed_at DESC
        LIMIT 1
      `;
      const existing = (existingLogs as unknown as Record<string, unknown>[])[0];
      if (existing) return { log: existing, created: false };

      const logRows = await tx`
        INSERT INTO marketing_execution_logs (hive_id, campaign_id, asset_id, external_action_request_id, action, connector, trace)
        VALUES (${hiveId}, ${asset.campaign_id as string}, ${assetId}, ${asset.external_action_request_id as string}, ${action}, ${connector},
                ${JSON.stringify(["asset_drafted", "owner_approved", "execution_logged"])}::jsonb)
        ON CONFLICT (external_action_request_id) WHERE external_action_request_id IS NOT NULL
        DO UPDATE SET external_action_request_id = EXCLUDED.external_action_request_id
        RETURNING id, hive_id, campaign_id, asset_id, external_action_request_id, action, connector, executed_at, trace
      `;
      const log = (logRows as unknown as Record<string, unknown>[])[0];
      if (!log) throw new ConflictError("Marketing execution log could not be recorded");

      const requestRows = await tx`
        UPDATE external_action_requests
        SET state = 'succeeded', executed_at = COALESCE(executed_at, now()), completed_at = COALESCE(completed_at, now()), updated_at = now(),
            execution_metadata = execution_metadata || ${JSON.stringify({ marketingExecution: connector })}::jsonb
        WHERE id = ${asset.external_action_request_id as string}
          AND hive_id = ${hiveId}
          AND decision_id = ${asset.external_action_decision_id as string}
          AND state IN ('approved', 'succeeded')
        RETURNING id
      `;
      if ((requestRows as unknown[]).length !== 1) {
        throw new ConflictError("Marketing external action request could not be finalized for execution");
      }

      const assetUpdateRows = await tx`
        UPDATE marketing_assets
        SET publication_status = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
        WHERE id = ${assetId}
          AND hive_id = ${hiveId}
          AND approval_status = 'approved'
        RETURNING id
      `;
      if ((assetUpdateRows as unknown[]).length !== 1) {
        throw new ConflictError("Marketing asset publication state could not be finalized");
      }

      const campaignRows = await tx`
        UPDATE marketing_campaigns
        SET status = 'running', updated_at = now()
        WHERE id = ${asset.campaign_id as string}
          AND hive_id = ${hiveId}
          AND status IN ('approved', 'draft', 'approval', 'running')
        RETURNING id
      `;
      if ((campaignRows as unknown[]).length !== 1) {
        throw new ConflictError("Marketing campaign execution state could not be finalized");
      }

      return { log, created: true };
    });

    return jsonOk({ executionLog: mapExecutionLog(result.log) }, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof ConflictError) return jsonError(error.message, 409);
    return jsonError("Failed to create marketing execution log", 500);
  }
}
