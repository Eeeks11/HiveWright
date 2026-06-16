import { sql } from "../../../../_lib/db";
import { requireApiUser } from "../../../../_lib/auth";
import { jsonError, jsonOk } from "../../../../_lib/responses";
import { canMutateHive } from "@/auth/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function mapCampaign(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    status: row.status as string,
    spendBudgetCents: (row.spend_budget_cents as number | null) ?? null,
    approvalPolicy: (row.approval_policy as Record<string, unknown>) ?? {},
  };
}

function campaignIdFromRequest(request: Request, params: { campaignId?: string }) {
  return params.campaignId ?? new URL(request.url).pathname.match(/\/campaigns\/([^/]+)/)?.[1] ?? "";
}

export async function POST(request: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const campaignId = campaignIdFromRequest(request, await params);
    const body = await request.json();
    const hiveId = body.hiveId;

    if (!isUuid(hiveId) || !isUuid(campaignId)) return jsonError("hiveId and campaignId must be UUIDs", 400);
    if (!authz.user.isSystemOwner && !(await canMutateHive(sql, authz.user.id, hiveId))) {
      return jsonError("Forbidden: caller cannot manage this hive", 403);
    }

    const rows = await sql`
      WITH eligible AS (
        SELECT id, hive_id, spend_budget_cents, approval_policy
        FROM marketing_campaigns
        WHERE id = ${campaignId}
          AND hive_id = ${hiveId}
          AND channels ? 'ads'
          AND status = 'approved'
          AND spend_budget_cents IS NOT NULL
          AND spend_budget_cents > 0
          AND approval_policy->'paidAdsBudgetApproval'->>'approvalStatus' = 'approved'
          AND ((approval_policy->'paidAdsBudgetApproval'->>'requestedBudgetCents')::integer = spend_budget_cents)
      ), updated AS (
        UPDATE marketing_campaigns mc
        SET status = 'running', updated_at = now()
        FROM eligible e
        WHERE mc.id = e.id
        RETURNING mc.id, mc.hive_id, mc.status, mc.spend_budget_cents, mc.approval_policy
      ), logged AS (
        INSERT INTO marketing_execution_logs (hive_id, campaign_id, action, connector, trace)
        SELECT hive_id, id, 'start_paid_ads_campaign_from_owner_approved_cap', 'manual_import',
               jsonb_build_array('budget_cap_owner_approved', 'paid_campaign_started_without_live_connector_spend')
        FROM updated
      )
      SELECT * FROM updated
    `;
    const campaign = (rows as unknown as Record<string, unknown>[])[0];
    if (!campaign) return jsonError("Paid ads cannot start without an explicit owner-approved budget cap", 409);

    return jsonOk({ campaign: mapCampaign(campaign) });
  } catch {
    return jsonError("Failed to start paid ads campaign", 500);
  }
}
