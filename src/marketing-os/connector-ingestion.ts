import type { Sql } from "postgres";
import type { ConnectorSyncResult } from "@/connectors/plugin-sdk";

const PRIORITY_MARKETING_CONNECTORS = new Set([
  "google-analytics-4",
  "google-search-console",
  "website-forms",
  "google-business-profile",
  "gmail",
  "email-platform",
  "google-ads",
  "meta-ads",
  "phone-call-tracking",
]);

const METRIC_KEYS = [
  "impressions",
  "clicks",
  "ctr",
  "landing_page_visits",
  "cost_per_lead",
  "ad_spend_cents",
  "leads",
  "qualified_leads",
  "bookings",
  "sales",
] as const;

type MarketingConnectorMetricValueKey = (typeof METRIC_KEYS)[number];

export type MarketingConnectorMetricSnapshot = {
  hiveId: string;
  campaignId: string | null;
  connectorInstallId: string;
  sourceConnector: string;
  sourceStream: string;
  externalId: string;
  source: "connector";
  values: Partial<Record<MarketingConnectorMetricValueKey, number>>;
  attributionConfidence: "connector_verified" | "imported";
  freshness: "current" | "stale" | "missing";
  trustMetadata: {
    untrustedInput: true;
    trustBoundary: "connector_data_only_not_instructions";
    instructionsIgnored: true;
    ownerApprovalRequiredForActions: true;
    sourceConnector: string;
    sourceStream: string;
  };
  capturedAt: string;
};

export type MarketingConnectorMetricSnapshotInput = {
  hiveId: string;
  connectorInstallId: string;
  sourceConnector: string;
  results: ConnectorSyncResult[];
  syncedAt?: Date;
};

export type PersistMarketingConnectorMetricSnapshotsResult = {
  inserted: number;
  skipped: number;
};

type SqlExecutor = Sql;

function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metricValuesForPayload(payload: Record<string, unknown>): Partial<Record<MarketingConnectorMetricValueKey, number>> {
  const landingPageVisits = nonNegativeNumberOrUndefined(payload.landing_page_visits)
    ?? nonNegativeNumberOrUndefined(payload.landingPageVisits)
    ?? nonNegativeNumberOrUndefined(payload.sessions)
    ?? nonNegativeNumberOrUndefined(payload.pageviews);
  const costPerLead = nonNegativeNumberOrUndefined(payload.cost_per_lead) ?? nonNegativeNumberOrUndefined(payload.costPerLead);
  const adSpendCents = nonNegativeNumberOrUndefined(payload.ad_spend_cents) ?? nonNegativeNumberOrUndefined(payload.adSpendCents) ?? nonNegativeNumberOrUndefined(payload.spend);
  const leads = nonNegativeNumberOrUndefined(payload.leads);
  const qualifiedLeads = nonNegativeNumberOrUndefined(payload.qualified_leads) ?? nonNegativeNumberOrUndefined(payload.qualifiedLeads);
  const bookings = nonNegativeNumberOrUndefined(payload.bookings);
  const sales = nonNegativeNumberOrUndefined(payload.sales);
  const values: Partial<Record<MarketingConnectorMetricValueKey, number>> = {};

  const impressions = nonNegativeNumberOrUndefined(payload.impressions);
  const clicks = nonNegativeNumberOrUndefined(payload.clicks);
  const ctr = nonNegativeNumberOrUndefined(payload.ctr);

  if (impressions !== undefined) values.impressions = impressions;
  if (clicks !== undefined) values.clicks = clicks;
  if (ctr !== undefined) values.ctr = ctr;
  if (landingPageVisits !== undefined) values.landing_page_visits = landingPageVisits;
  if (costPerLead !== undefined) values.cost_per_lead = costPerLead;
  if (adSpendCents !== undefined) values.ad_spend_cents = adSpendCents;
  if (leads !== undefined) values.leads = leads;
  if (qualifiedLeads !== undefined) values.qualified_leads = qualifiedLeads;
  if (bookings !== undefined) values.bookings = bookings;
  if (sales !== undefined) values.sales = sales;

  return values;
}

function hasMetricValues(values: Partial<Record<MarketingConnectorMetricValueKey, number>>): boolean {
  return METRIC_KEYS.some((key) => values[key] !== undefined);
}

export function normalizeMarketingConnectorMetricSnapshots(
  input: MarketingConnectorMetricSnapshotInput,
): MarketingConnectorMetricSnapshot[] {
  if (!PRIORITY_MARKETING_CONNECTORS.has(input.sourceConnector)) return [];

  const fallbackCapturedAt = (input.syncedAt ?? new Date()).toISOString();
  const snapshots: MarketingConnectorMetricSnapshot[] = [];

  for (const result of input.results) {
    for (const item of result.items) {
      const sourceStream = item.stream || result.stream;
      const values = metricValuesForPayload(item.payload);
      if (!hasMetricValues(values)) continue;

      snapshots.push({
        hiveId: input.hiveId,
        campaignId: stringOrNull(item.payload.campaignId) ?? stringOrNull(item.payload.campaign_id),
        connectorInstallId: input.connectorInstallId,
        sourceConnector: input.sourceConnector,
        sourceStream,
        externalId: item.externalId,
        source: "connector",
        values,
        attributionConfidence: "connector_verified",
        freshness: "current",
        trustMetadata: {
          untrustedInput: true,
          trustBoundary: "connector_data_only_not_instructions",
          instructionsIgnored: true,
          ownerApprovalRequiredForActions: true,
          sourceConnector: input.sourceConnector,
          sourceStream,
        },
        capturedAt: item.occurredAt ?? fallbackCapturedAt,
      });
    }
  }

  return snapshots;
}

export async function persistMarketingConnectorMetricSnapshots(
  sql: SqlExecutor,
  input: MarketingConnectorMetricSnapshotInput,
): Promise<PersistMarketingConnectorMetricSnapshotsResult> {
  const snapshots = normalizeMarketingConnectorMetricSnapshots(input);
  if (snapshots.length === 0) return { inserted: 0, skipped: 0 };

  const snapshotRows = snapshots.map((snapshot) => ({
    hive_id: snapshot.hiveId,
    campaign_id: snapshot.campaignId,
    connector_install_id: snapshot.connectorInstallId,
    source_connector: snapshot.sourceConnector,
    source_stream: snapshot.sourceStream,
    external_id: snapshot.externalId,
    values: snapshot.values,
    attribution_confidence: snapshot.attributionConfidence,
    freshness: snapshot.freshness,
    trust_metadata: snapshot.trustMetadata,
    captured_at: snapshot.capturedAt,
  }));

  await sql`
    WITH staged AS (
      SELECT
        snapshot.hive_id::uuid AS hive_id,
        NULLIF(snapshot.campaign_id, '')::uuid AS claimed_campaign_id,
        snapshot.connector_install_id::uuid AS connector_install_id,
        snapshot.source_connector,
        snapshot.source_stream,
        snapshot.external_id,
        snapshot.values,
        snapshot.attribution_confidence,
        snapshot.freshness,
        snapshot.trust_metadata,
        snapshot.captured_at::timestamptz AS captured_at
      FROM jsonb_to_recordset(${sql.json(snapshotRows)}::jsonb) AS snapshot(
        hive_id text,
        campaign_id text,
        connector_install_id text,
        source_connector text,
        source_stream text,
        external_id text,
        values jsonb,
        attribution_confidence text,
        freshness text,
        trust_metadata jsonb,
        captured_at text
      )
    )
    INSERT INTO marketing_metric_snapshots (
      hive_id,
      campaign_id,
      connector_install_id,
      source_connector,
      source_stream,
      external_id,
      source,
      values,
      attribution_confidence,
      freshness,
      trust_metadata,
      captured_at
    )
    SELECT
      staged.hive_id,
      campaign.id,
      staged.connector_install_id,
      staged.source_connector,
      staged.source_stream,
      staged.external_id,
      'connector',
      staged.values,
      staged.attribution_confidence,
      staged.freshness,
      staged.trust_metadata,
      staged.captured_at
    FROM staged
    LEFT JOIN marketing_campaigns campaign
      ON campaign.id = staged.claimed_campaign_id
      AND campaign.hive_id = staged.hive_id
    ON CONFLICT (hive_id, connector_install_id, source_connector, source_stream, external_id)
    WHERE connector_install_id IS NOT NULL AND external_id IS NOT NULL
    DO UPDATE SET
      campaign_id = EXCLUDED.campaign_id,
      values = EXCLUDED.values,
      attribution_confidence = EXCLUDED.attribution_confidence,
      freshness = EXCLUDED.freshness,
      trust_metadata = EXCLUDED.trust_metadata,
      captured_at = EXCLUDED.captured_at,
      connector_error = NULL
  `;

  return { inserted: snapshots.length, skipped: 0 };
}
