import { sql } from "../_lib/db";
import { requireApiUser } from "../_lib/auth";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";
import { canAccessHive, canMutateHive } from "@/auth/users";
import { buildMarketingDashboardSnapshot, createMarketingObjectiveDraft, type MarketingChannel } from "@/marketing-os/foundation";
import type { ConnectorSourceInput } from "@/operating-systems/connector-data-sources";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_CHANNELS = new Set(["seo", "google_business_profile", "social", "email", "ads", "partnerships", "print_offline"]);
const BASE_SUCCESS_METRICS = ["impressions", "clicks", "ctr", "landing_page_visits", "cost_per_lead"];
const PAID_ADS_SUCCESS_METRICS = [...BASE_SUCCESS_METRICS, "ad_spend_cents", "leads", "qualified_leads", "bookings", "sales"];

function isUuid(value: string | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function mapCampaign(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    domain: "marketing-attention" as const,
    objective: row.objective as string,
    targetAudience: (row.target_audience as string | null) ?? "",
    offer: (row.offer as string | null) ?? "",
    channels: (row.channels as MarketingChannel[]) ?? [],
    status: row.status as never,
    spendBudgetCents: (row.spend_budget_cents as number | null) ?? null,
    successMetrics: (row.success_metrics as string[]) ?? [],
    createdAt: ((row.created_at as Date | string).toString ? new Date(row.created_at as never).toISOString() : String(row.created_at)),
  };
}

function successMetricsForChannels(channels: MarketingChannel[]) {
  return channels.includes("ads") ? PAID_ADS_SUCCESS_METRICS : BASE_SUCCESS_METRICS;
}

function mapAsset(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    hiveId: row.hive_id as string,
    externalActionRequestId: (row.external_action_request_id as string | null) ?? null,
    externalActionDecisionId: (row.external_action_decision_id as string | null) ?? null,
    channel: row.channel as MarketingChannel,
    assetType: row.asset_type as string,
    title: row.title as string,
    draftBody: row.draft_body as string,
    approvalStatus: row.approval_status as never,
    publicationStatus: row.publication_status as never,
    scheduledFor: row.scheduled_for ? new Date(row.scheduled_for as never).toISOString() : "",
  };
}

function mapMetric(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    source: row.source as "manual_import" | "connector",
    connectorInstallId: (row.connector_install_id as string | null) ?? null,
    sourceConnector: (row.source_connector as string | null) ?? null,
    sourceStream: (row.source_stream as string | null) ?? null,
    externalId: (row.external_id as string | null) ?? null,
    capturedAt: new Date(row.captured_at as never).toISOString(),
    values: (row.values as Record<string, number>) ?? {},
    attributionConfidence: row.attribution_confidence as never,
    freshness: row.freshness as never,
    trustMetadata: (row.trust_metadata as Record<string, unknown>) ?? {},
  };
}

function mapExecution(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    assetId: row.asset_id as string,
    action: row.action as string,
    connector: row.connector as never,
    executedAt: new Date(row.executed_at as never).toISOString(),
    trace: (row.trace as ["asset_drafted", "owner_approved", "execution_logged"]) ?? ["asset_drafted", "owner_approved", "execution_logged"],
  };
}

function toIsoOrNull(value: unknown) {
  return value ? new Date(value as never).toISOString() : null;
}

function mapConnectorSource(row: Record<string, unknown>): ConnectorSourceInput {
  const streams = Array.isArray(row.streams) ? row.streams as Record<string, unknown>[] : [];
  return {
    installId: row.install_id as string,
    connectorSlug: row.connector_slug as string,
    displayName: row.display_name as string,
    status: row.status as ConnectorSourceInput["status"],
    lastTestedAt: toIsoOrNull(row.last_tested_at),
    lastError: (row.last_error as string | null) ?? null,
    streams: streams.map((stream) => ({
      stream: stream.stream as string,
      freshness: stream.freshness as never,
      lastSyncedAt: toIsoOrNull(stream.lastSyncedAt ?? stream.last_synced_at),
      lastError: (stream.lastError as string | null) ?? (stream.last_error as string | null) ?? null,
    })),
  };
}

async function ensureCanReadHive(user: { id: string; isSystemOwner: boolean }, hiveId: string) {
  if (user.isSystemOwner) return true;
  return canAccessHive(sql, user.id, hiveId);
}

async function ensureCanMutateHive(user: { id: string; isSystemOwner: boolean }, hiveId: string) {
  if (user.isSystemOwner) return true;
  return canMutateHive(sql, user.id, hiveId);
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const hiveId = parseSearchParams(request.url).get("hiveId");
  if (!isUuid(hiveId)) return jsonError("hiveId must be a UUID", 400);
  if (!(await ensureCanReadHive(authz.user, hiveId))) return jsonError("Forbidden: caller cannot access this hive", 403);

  try {
    const campaigns = await sql`
      SELECT id, hive_id, objective, status, channels, target_audience, offer, spend_budget_cents, success_metrics, created_at
      FROM marketing_campaigns
      WHERE hive_id = ${hiveId}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    const assets = await sql`
      SELECT ma.id, ma.hive_id, ma.campaign_id, ma.external_action_request_id,
             ear.decision_id AS external_action_decision_id, ma.channel, ma.asset_type, ma.title, ma.draft_body,
             ma.approval_status, ma.publication_status, ma.scheduled_for
      FROM marketing_assets ma
      LEFT JOIN external_action_requests ear ON ear.id = ma.external_action_request_id AND ear.hive_id = ma.hive_id
      WHERE ma.hive_id = ${hiveId}
      ORDER BY ma.created_at DESC
      LIMIT 100
    `;
    const metrics = await sql`
      SELECT DISTINCT ON (campaign_id) id, campaign_id, source, connector_install_id, source_connector, source_stream, external_id,
             captured_at, values, attribution_confidence, freshness, trust_metadata
      FROM marketing_metric_snapshots
      WHERE hive_id = ${hiveId}
      ORDER BY campaign_id, captured_at DESC
    `;
    const executionLogs = await sql`
      SELECT id, campaign_id, asset_id, action, connector, executed_at, trace
      FROM marketing_execution_logs
      WHERE hive_id = ${hiveId}
      ORDER BY executed_at DESC
      LIMIT 100
    `;
    const connectorSources = await sql`
      SELECT ci.id AS install_id, ci.connector_slug, ci.display_name, ci.status, ci.last_tested_at, ci.last_error,
             COALESCE(
               jsonb_agg(jsonb_build_object(
                 'stream', csc.stream,
                 'freshness', CASE
                   WHEN csc.last_synced_at IS NULL THEN 'missing'
                   WHEN csc.last_synced_at < now() - interval '25 hours' THEN 'stale'
                   ELSE 'current'
                 END,
                 'lastSyncedAt', csc.last_synced_at,
                 'lastError', csc.last_error
               ) ORDER BY csc.stream) FILTER (WHERE csc.id IS NOT NULL),
               '[]'::jsonb
             ) AS streams
      FROM connector_installs ci
      LEFT JOIN connector_sync_cursors csc ON csc.install_id = ci.id
      WHERE ci.hive_id = ${hiveId}
        AND ci.connector_slug IN ('google-analytics-4', 'google-search-console', 'website-forms', 'google-business-profile', 'email-platform', 'google-ads', 'meta-ads')
      GROUP BY ci.id, ci.connector_slug, ci.display_name, ci.status, ci.last_tested_at, ci.last_error
      ORDER BY ci.display_name ASC
    `;

    return jsonOk(buildMarketingDashboardSnapshot({
      campaigns: (campaigns as unknown as Record<string, unknown>[]).map(mapCampaign),
      assets: (assets as unknown as Record<string, unknown>[]).map(mapAsset),
      metrics: (metrics as unknown as Record<string, unknown>[]).map(mapMetric),
      executionLogs: (executionLogs as unknown as Record<string, unknown>[]).map(mapExecution),
      connectorSources: (connectorSources as unknown as Record<string, unknown>[]).map(mapConnectorSource),
    }));
  } catch {
    return jsonError("Failed to fetch marketing dashboard", 500);
  }
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json();
    const hiveId = cleanString(body.hiveId);
    const objective = cleanString(body.objective);
    const targetAudience = cleanString(body.targetAudience);
    const offer = cleanString(body.offer);
    const channels = Array.isArray(body.channels)
      ? body.channels.filter((channel: unknown): channel is MarketingChannel => typeof channel === "string" && ALLOWED_CHANNELS.has(channel))
      : [];

    if (!isUuid(hiveId)) return jsonError("hiveId must be a UUID", 400);
    if (!objective || !targetAudience || !offer || channels.length === 0) {
      return jsonError("objective, targetAudience, offer, and at least one valid channel are required", 400);
    }
    if (!(await ensureCanMutateHive(authz.user, hiveId))) return jsonError("Forbidden: caller cannot manage this hive", 403);

    const draft = createMarketingObjectiveDraft({ hiveId, objective, targetAudience, offer, channels });
    const successMetrics = successMetricsForChannels(channels);
    const profileRows = await sql`
      INSERT INTO marketing_profiles (hive_id, industry, target_customers, offers, service_areas, approval_policy)
      VALUES (${hiveId}, ${"unspecified"}, ${JSON.stringify([targetAudience])}::jsonb, ${JSON.stringify([offer])}::jsonb, ${JSON.stringify([])}::jsonb,
              ${JSON.stringify({ publicOrSpendActions: "owner_approval_required", defaultAutonomyLevel: 1 })}::jsonb)
      ON CONFLICT (hive_id) DO UPDATE SET updated_at = now()
      RETURNING id
    `;
    const campaignRows = await sql`
      INSERT INTO marketing_campaigns (hive_id, profile_id, objective, status, channels, target_audience, offer, success_metrics, approval_policy)
      VALUES (${hiveId}, ${(profileRows[0] as { id: string }).id}, ${objective}, ${"draft"}, ${JSON.stringify(channels)}::jsonb,
              ${targetAudience}, ${offer}, ${JSON.stringify(successMetrics)}::jsonb,
              ${JSON.stringify({ publicOrSpendActions: "owner_approval_required" })}::jsonb)
      RETURNING id, hive_id, objective, status, channels, target_audience, offer, spend_budget_cents, success_metrics, created_at
    `;
    const campaign = mapCampaign((campaignRows as unknown as Record<string, unknown>[])[0]);
    const assetPayload = draft.assets.map((asset) => ({
      channel: asset.channel,
      assetType: asset.assetType,
      title: asset.title,
      draftBody: asset.draftBody,
      scheduledFor: asset.scheduledFor,
      requestPayload: {
        domain: "marketing-attention",
        campaignId: campaign.id,
        channel: asset.channel,
        title: asset.title,
        draftBody: asset.draftBody,
      },
    }));

    const assetRows = await sql`
      WITH payload AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(assetPayload)}::jsonb)
          AS x(channel text, "assetType" text, title text, "draftBody" text, "scheduledFor" timestamptz, "requestPayload" jsonb)
      ), action_requests AS (
        INSERT INTO external_action_requests (hive_id, connector, operation, state, requested_by, request_payload, policy_snapshot)
        SELECT ${hiveId}, channel, 'publish_marketing_asset', 'awaiting_approval', ${authz.user.id}, "requestPayload",
               ${JSON.stringify({ publicOrSpendActions: "owner_approval_required" })}::jsonb
        FROM payload
        RETURNING id, request_payload
      ), approval_decisions AS (
        INSERT INTO decisions (hive_id, title, context, recommendation, options, priority, status, kind, route_metadata)
        SELECT ${hiveId},
               'Approve marketing asset publication?',
               'Marketing OS asset draft requires owner approval before any public, spend, or customer-facing execution.',
               'Approve only if the draft matches the offer, brand voice, and risk boundary.',
               ${JSON.stringify([
                 { key: "approve", label: "Approve", consequence: "Allow this marketing asset to be queued for execution." },
                 { key: "reject", label: "Reject", consequence: "Block this marketing asset from execution." },
               ])}::jsonb,
               'normal', 'pending', 'external_action_approval',
               jsonb_build_object('externalActionRequestId', ar.id, 'connectorSlug', p.channel, 'operation', 'publish_marketing_asset', 'domain', 'marketing-attention')
        FROM action_requests ar
        JOIN payload p ON ar.request_payload->>'title' = p.title
        RETURNING id, route_metadata
      ), linked_requests AS (
        UPDATE external_action_requests ear
        SET decision_id = ad.id, updated_at = now()
        FROM approval_decisions ad
        WHERE ear.id = (ad.route_metadata->>'externalActionRequestId')::uuid
        RETURNING ear.id, ear.decision_id, ear.request_payload
      )
      INSERT INTO marketing_assets (hive_id, campaign_id, external_action_request_id, channel, asset_type, title, draft_body, scheduled_for)
      SELECT ${hiveId}, ${campaign.id}, lr.id, p.channel, p."assetType", p.title, p."draftBody", p."scheduledFor"
      FROM payload p
      JOIN linked_requests lr ON lr.request_payload->>'title' = p.title
      RETURNING id, hive_id, campaign_id, external_action_request_id, channel, asset_type, title, draft_body,
                approval_status, publication_status, scheduled_for
    `;

    return jsonOk({ campaign, assets: (assetRows as unknown as Record<string, unknown>[]).map(mapAsset) }, 201);
  } catch {
    return jsonError("Failed to create marketing objective", 500);
  }
}
