import { sql } from "../../../../_lib/db";
import { requireApiUser } from "../../../../_lib/auth";
import { jsonError, jsonOk } from "../../../../_lib/responses";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function mapCampaign(row: Record<string, unknown>) {
  const approvalPolicy = (row.approval_policy as Record<string, unknown>) ?? {};
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    status: row.status as string,
    spendBudgetCents: (row.spend_budget_cents as number | null) ?? null,
    approvalPolicy,
  };
}

function campaignIdFromRequest(request: Request, params: { campaignId?: string }) {
  return params.campaignId ?? new URL(request.url).pathname.match(/\/campaigns\/([^/]+)/)?.[1] ?? "";
}

async function canApprovePaidSpend(user: { id: string; isSystemOwner: boolean }, hiveId: string) {
  if (user.isSystemOwner) return true;
  if (!isUuid(user.id) || !isUuid(hiveId)) return false;

  const rows = await sql<{ c: number }[]>`
    SELECT COUNT(*)::int AS c
    FROM hive_memberships
    WHERE user_id = ${user.id}
      AND hive_id = ${hiveId}::uuid
      AND role = 'owner'
  `;

  return (rows[0]?.c ?? 0) > 0;
}

export async function POST(request: Request, { params }: { params: Promise<{ campaignId: string }> }) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const campaignId = campaignIdFromRequest(request, await params);
    const body = await request.json();
    const hiveId = body.hiveId;
    const requestedBudgetCents = body.requestedBudgetCents;
    const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;

    if (!isUuid(hiveId) || !isUuid(campaignId)) return jsonError("hiveId and campaignId must be UUIDs", 400);
    if (!Number.isInteger(requestedBudgetCents) || requestedBudgetCents <= 0) {
      return jsonError("Paid ads require an explicit positive owner-approved budget cap in cents", 400);
    }
    if (!(await canApprovePaidSpend(authz.user, hiveId))) {
      return jsonError("Forbidden: only the hive owner can approve paid ads spend caps", 403);
    }

    const policySnapshot = {
      spendCapRequired: true,
      ownerApprovalRequired: true,
      pauseOrKillRulesRequired: true,
      liveSpendExecution: "not_performed_by_this_route",
    };
    const budgetApproval = {
      approvalStatus: "approved",
      requestedBudgetCents,
      ownerId: authz.user.id,
      reason,
      approvedAt: new Date().toISOString(),
      policySnapshot,
    };

    const rows = await sql`
      UPDATE marketing_campaigns
      SET status = 'approved',
          spend_budget_cents = ${requestedBudgetCents},
          approval_policy = COALESCE(approval_policy, '{}'::jsonb) || ${JSON.stringify({ paidAdsBudgetApproval: budgetApproval })}::jsonb,
          updated_at = now()
      WHERE id = ${campaignId}
        AND hive_id = ${hiveId}
        AND channels ? 'ads'
      RETURNING id, hive_id, status, spend_budget_cents, approval_policy
    `;
    const campaign = (rows as unknown as Record<string, unknown>[])[0];
    if (!campaign) return jsonError("Paid ads campaign not found for this hive", 404);

    return jsonOk({ campaign: mapCampaign(campaign), budgetApproval: (campaign.approval_policy as Record<string, unknown>).paidAdsBudgetApproval });
  } catch {
    return jsonError("Failed to approve paid ads budget", 500);
  }
}
