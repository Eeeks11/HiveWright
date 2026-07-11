import { sql } from "../../../../_lib/db";
import { requireApiUser } from "../../../../_lib/auth";
import { jsonError, jsonOk } from "../../../../_lib/responses";
import { canMutateHive } from "@/auth/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function positiveNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function mapCampaign(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    status: row.status as string,
    spendBudgetCents: (row.spend_budget_cents as number | null) ?? null,
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
    const maxCostPerLeadCents = positiveNumber(body.maxCostPerLeadCents, 10000);
    const minLeadQualityRate = positiveNumber(body.minLeadQualityRate, 0);
    const minLeadToBookingRate = positiveNumber(body.minLeadToBookingRate, 0);

    if (!isUuid(hiveId) || !isUuid(campaignId)) return jsonError("hiveId and campaignId must be UUIDs", 400);
    if (!authz.user.isSystemOwner && !(await canMutateHive(sql, authz.user.id, hiveId))) {
      return jsonError("Forbidden: caller cannot manage this hive", 403);
    }

    const rows = await sql`
      WITH campaign AS (
        SELECT id, hive_id, status, spend_budget_cents
        FROM marketing_campaigns
        WHERE id = ${campaignId}
          AND hive_id = ${hiveId}
          AND channels ? 'ads'
          AND status = 'running'
      ), latest_metric AS (
        SELECT
          (
            SELECT ms.values->>'ad_spend_cents'
            FROM marketing_metric_snapshots ms
            WHERE ms.campaign_id = ${campaignId}
              AND ms.hive_id = ${hiveId}
              AND ms.values ? 'ad_spend_cents'
            ORDER BY ms.captured_at DESC
            LIMIT 1
          ) AS ad_spend_cents,
          (
            SELECT ms.values->>'leads'
            FROM marketing_metric_snapshots ms
            WHERE ms.campaign_id = ${campaignId}
              AND ms.hive_id = ${hiveId}
              AND ms.values ? 'leads'
            ORDER BY ms.captured_at DESC
            LIMIT 1
          ) AS leads,
          (
            SELECT ms.values->>'qualified_leads'
            FROM marketing_metric_snapshots ms
            WHERE ms.campaign_id = ${campaignId}
              AND ms.hive_id = ${hiveId}
              AND ms.values ? 'qualified_leads'
            ORDER BY ms.captured_at DESC
            LIMIT 1
          ) AS qualified_leads,
          (
            SELECT ms.values->>'bookings'
            FROM marketing_metric_snapshots ms
            WHERE ms.campaign_id = ${campaignId}
              AND ms.hive_id = ${hiveId}
              AND ms.values ? 'bookings'
            ORDER BY ms.captured_at DESC
            LIMIT 1
          ) AS bookings
      ), scored AS (
        SELECT c.id, c.hive_id, c.spend_budget_cents,
               COALESCE(m.ad_spend_cents::numeric, 0) AS ad_spend_cents,
               COALESCE(m.leads::numeric, 0) AS leads,
               COALESCE(m.qualified_leads::numeric, 0) AS qualified_leads,
               COALESCE(m.bookings::numeric, 0) AS bookings
        FROM campaign c
        LEFT JOIN latest_metric m ON true
      ), decision AS (
        SELECT id, hive_id, spend_budget_cents, ad_spend_cents, leads, qualified_leads, bookings,
               CASE WHEN leads > 0 THEN round(ad_spend_cents / leads)::integer ELSE NULL END AS cost_per_lead_cents,
               CASE WHEN leads > 0 THEN qualified_leads / leads ELSE NULL END AS lead_quality_rate,
               CASE WHEN leads > 0 THEN bookings / leads ELSE NULL END AS lead_to_booking_rate
        FROM scored
      ), reasoned AS (
        SELECT *,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN spend_budget_cents IS NULL OR spend_budget_cents <= 0 THEN 'Missing owner-approved paid ads budget cap.' END,
            CASE WHEN spend_budget_cents > 0 AND ad_spend_cents >= spend_budget_cents THEN 'Spend has reached the owner-approved budget cap.' END,
            CASE WHEN cost_per_lead_cents IS NOT NULL AND cost_per_lead_cents > ${maxCostPerLeadCents} THEN 'Cost per lead ' || cost_per_lead_cents || 'c exceeds policy cap ' || ${maxCostPerLeadCents}::text || 'c.' END,
            CASE WHEN lead_quality_rate IS NOT NULL AND lead_quality_rate < ${minLeadQualityRate} THEN 'Lead quality rate is below policy minimum.' END,
            CASE WHEN lead_to_booking_rate IS NOT NULL AND lead_to_booking_rate < ${minLeadToBookingRate} THEN 'Downstream lead-to-booking conversion is below policy minimum.' END
          ], NULL) AS reasons
        FROM decision
      ), final_decision AS (
        SELECT id, hive_id,
          CASE WHEN spend_budget_cents > 0 AND ad_spend_cents > spend_budget_cents THEN 'kill'
               WHEN array_length(reasons, 1) > 0 THEN 'pause'
               ELSE 'keep' END AS rule,
          CASE WHEN spend_budget_cents > 0 AND ad_spend_cents > spend_budget_cents THEN 'killed'
               WHEN array_length(reasons, 1) > 0 THEN 'paused'
               ELSE 'running' END AS recommended_status,
          CASE WHEN array_length(reasons, 1) > 0 THEN to_jsonb(reasons)
               ELSE jsonb_build_array('Paid campaign is within approved spend and conversion policy.') END AS reasons,
          jsonb_build_object(
            'adSpendCents', ad_spend_cents::integer,
            'spendBudgetCents', spend_budget_cents,
            'costPerLeadCents', cost_per_lead_cents,
            'leadQualityRate', lead_quality_rate,
            'leadToBookingRate', lead_to_booking_rate
          ) AS metrics
        FROM reasoned
      ), updated AS (
        UPDATE marketing_campaigns mc
        SET status = fd.recommended_status, updated_at = now()
        FROM final_decision fd
        WHERE mc.id = fd.id
        RETURNING mc.id, mc.hive_id, mc.status, mc.spend_budget_cents, fd.rule, fd.recommended_status, fd.reasons, fd.metrics
      ), logged AS (
        INSERT INTO marketing_execution_logs (hive_id, campaign_id, action, connector, trace)
        SELECT hive_id, id, 'apply_paid_campaign_policy_' || rule, 'manual_import',
               jsonb_build_array('paid_metrics_ingested', 'policy_evaluated', 'campaign_status_applied')
        FROM updated
      )
      SELECT id, hive_id, status, spend_budget_cents,
             jsonb_build_object('campaignId', id, 'rule', rule, 'recommendedStatus', recommended_status, 'reasons', reasons, 'metrics', metrics) AS decision
      FROM updated
    `;
    const row = (rows as unknown as Record<string, unknown>[])[0];
    if (!row) return jsonError("Running paid ads campaign not found for policy evaluation", 404);

    return jsonOk({ campaign: mapCampaign(row), decision: row.decision });
  } catch {
    return jsonError("Failed to evaluate paid ads policy", 500);
  }
}
