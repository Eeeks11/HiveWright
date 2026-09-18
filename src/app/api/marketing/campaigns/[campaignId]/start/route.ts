import { sql } from "../../../../_lib/db";
import { requireApiUser } from "../../../../_lib/auth";
import { jsonError } from "../../../../_lib/responses";
import { canMutateHive } from "@/auth/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
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
      SELECT id, hive_id, status, spend_budget_cents, approval_policy
      FROM marketing_campaigns
      WHERE id = ${campaignId}
        AND hive_id = ${hiveId}
        AND channels ? 'ads'
        AND status = 'approved'
        AND spend_budget_cents IS NOT NULL
        AND spend_budget_cents > 0
        AND approval_policy->'paidAdsBudgetApproval'->>'approvalStatus' = 'approved'
        AND ((approval_policy->'paidAdsBudgetApproval'->>'requestedBudgetCents')::integer = spend_budget_cents)
      LIMIT 1
    `;
    const campaign = (rows as unknown as Record<string, unknown>[])[0];
    if (!campaign) return jsonError("Paid ads cannot start without an explicit owner-approved budget cap", 409);

    return jsonError("Paid ads require durable live connector execution proof before HiveWright can mark them running", 409);
  } catch {
    return jsonError("Failed to start paid ads campaign", 500);
  }
}
