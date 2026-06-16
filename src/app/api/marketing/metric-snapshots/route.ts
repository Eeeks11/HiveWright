import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { jsonError, jsonOk } from "../../_lib/responses";
import { canMutateHive } from "@/auth/users";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_METRICS = new Set(["impressions", "clicks", "ctr", "landing_page_visits", "cost_per_lead"]);
const ALLOWED_SOURCES = new Set(["manual_import", "connector"]);
const ALLOWED_ATTRIBUTION = new Set(["manual_unverified", "imported", "connector_verified"]);
const ALLOWED_FRESHNESS = new Set(["current", "stale", "missing"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function cleanMetricValues(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key, metricValue]) =>
      ALLOWED_METRICS.has(key) && typeof metricValue === "number" && Number.isFinite(metricValue) && metricValue >= 0,
    ),
  );
}

function mapMetric(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    campaignId: row.campaign_id as string,
    source: row.source as "manual_import" | "connector",
    capturedAt: new Date(row.captured_at as never).toISOString(),
    values: (row.values as Record<string, number>) ?? {},
    attributionConfidence: row.attribution_confidence as "manual_unverified" | "imported" | "connector_verified",
    freshness: row.freshness as "current" | "stale" | "missing",
  };
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json();
    const hiveId = body.hiveId;
    const campaignId = body.campaignId;
    const values = cleanMetricValues(body.values);
    const source = typeof body.source === "string" && ALLOWED_SOURCES.has(body.source) ? body.source : "manual_import";
    const attributionConfidence = typeof body.attributionConfidence === "string" && ALLOWED_ATTRIBUTION.has(body.attributionConfidence)
      ? body.attributionConfidence
      : "manual_unverified";
    const freshness = typeof body.freshness === "string" && ALLOWED_FRESHNESS.has(body.freshness) ? body.freshness : "current";

    if (!isUuid(hiveId) || !isUuid(campaignId)) return jsonError("hiveId and campaignId must be UUIDs", 400);
    if (Object.keys(values).length === 0) return jsonError("At least one numeric marketing metric value is required", 400);
    if (!authz.user.isSystemOwner && !(await canMutateHive(sql, authz.user.id, hiveId))) {
      return jsonError("Forbidden: caller cannot manage this hive", 403);
    }

    const rows = await sql`
      INSERT INTO marketing_metric_snapshots (hive_id, campaign_id, source, values, attribution_confidence, freshness)
      SELECT ${hiveId}, ${campaignId}, ${source}, ${JSON.stringify(values)}::jsonb, ${attributionConfidence}, ${freshness}
      FROM marketing_campaigns
      WHERE id = ${campaignId}
        AND hive_id = ${hiveId}
      RETURNING id, hive_id, campaign_id, source, values, attribution_confidence, freshness, captured_at
    `;
    const metric = (rows as unknown as Record<string, unknown>[])[0];
    if (!metric) return jsonError("Marketing campaign not found for this hive", 404);

    return jsonOk({ metricSnapshot: mapMetric(metric) }, 201);
  } catch {
    return jsonError("Failed to create marketing metric snapshot", 500);
  }
}
