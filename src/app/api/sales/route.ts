import { canAccessHive, canMutateHive } from "@/auth/users";
import {
  buildSalesDashboardSnapshot,
  createSalesOperatingPlan,
  type SalesActionDraft,
  type SalesActionPlan,
  type SalesBottleneck,
  type SalesFunnel,
  type SalesFunnelMetrics,
  type SalesFunnelStage,
  type SalesWorkflow,
} from "@/sales-os/foundation";
import type { ConnectorSourceInput } from "@/operating-systems/connector-data-sources";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_TYPES = new Set(["lead", "customer", "dormant_customer"]);
function isUuid(value: string | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function cleanMetrics(value: unknown): SalesFunnelMetrics {
  const metrics = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  return {
    traffic: cleanNumber(metrics.traffic),
    leads: cleanNumber(metrics.leads),
    responded: cleanNumber(metrics.responded),
    qualified: cleanNumber(metrics.qualified),
    booked: cleanNumber(metrics.booked),
    showed: cleanNumber(metrics.showed),
    sold: cleanNumber(metrics.sold),
    reviews: cleanNumber(metrics.reviews),
    referrals: cleanNumber(metrics.referrals),
    repeatPurchases: cleanNumber(metrics.repeatPurchases),
  };
}

function toIso(value: unknown) {
  return value ? new Date(value as never).toISOString() : new Date(0).toISOString();
}

function mapFunnel(row: Record<string, unknown>): SalesFunnel {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    domain: "sales-conversion",
    segmentId: (row.segment_id as string | null) ?? "",
    goal: row.goal as string,
    stages: (row.stages as SalesFunnelStage[]) ?? [],
    biggestLeak: (row.biggest_leak as SalesBottleneck) ?? {},
    capturedAt: toIso(row.captured_at),
  };
}

function mapActionPlan(row: Record<string, unknown>): SalesActionPlan {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    funnelId: row.funnel_id as string,
    bottleneck: (row.bottleneck as SalesBottleneck) ?? {},
    status: row.status as SalesActionPlan["status"],
    boundedBy: row.bounded_by as "one owner-approved sales conversion fix",
    approvalPolicy: (row.approval_policy as SalesActionPlan["approvalPolicy"]) ?? { outboundCustomerActions: "owner_approval_required" },
    nextMeasurement: row.next_measurement as string,
    createdAt: toIso(row.created_at),
  };
}

function mapActionDraft(row: Record<string, unknown>): SalesActionDraft & { externalActionRequestId?: string | null } {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    actionPlanId: row.action_plan_id as string,
    externalActionRequestId: (row.external_action_request_id as string | null) ?? null,
    workflow: row.workflow as SalesWorkflow,
    title: row.title as string,
    draftBody: row.draft_body as string,
    approvalStatus: row.approval_status as SalesActionDraft["approvalStatus"],
    executionStatus: row.execution_status as SalesActionDraft["executionStatus"],
  };
}

function mapExecution(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    actionPlanId: row.action_plan_id as string,
    actionDraftId: (row.action_draft_id as string | null) ?? "",
    workflow: row.workflow as SalesWorkflow,
    connector: row.connector as never,
    executedAt: toIso(row.executed_at),
    trace: (row.trace as never) ?? ["funnel_observed", "bottleneck_identified", "owner_approved", "execution_logged"],
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
    const funnels = await sql`
      SELECT id, hive_id, segment_id, goal, stages, biggest_leak, captured_at
      FROM sales_funnels
      WHERE hive_id = ${hiveId}
      ORDER BY captured_at DESC
      LIMIT 20
    `;
    const actionPlans = await sql`
      SELECT id, hive_id, funnel_id, bottleneck, status, bounded_by, approval_policy, next_measurement, created_at
      FROM sales_action_plans
      WHERE hive_id = ${hiveId}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    const actionDrafts = await sql`
      SELECT id, hive_id, action_plan_id, external_action_request_id, workflow, title, draft_body, approval_status, execution_status
      FROM sales_action_drafts
      WHERE hive_id = ${hiveId}
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const executionLogs = await sql`
      SELECT id, hive_id, action_plan_id, action_draft_id, workflow, connector, executed_at, trace
      FROM sales_execution_logs
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
        AND ci.connector_slug IN ('website-forms', 'email-platform', 'crm', 'booking', 'phone-call-tracking', 'google-business-profile')
      GROUP BY ci.id, ci.connector_slug, ci.display_name, ci.status, ci.last_tested_at, ci.last_error
      ORDER BY ci.display_name ASC
    `;

    return jsonOk(buildSalesDashboardSnapshot({
      funnels: (funnels as unknown as Record<string, unknown>[]).map(mapFunnel),
      actionPlans: (actionPlans as unknown as Record<string, unknown>[]).map(mapActionPlan),
      actionDrafts: (actionDrafts as unknown as Record<string, unknown>[]).map(mapActionDraft),
      executionLogs: (executionLogs as unknown as Record<string, unknown>[]).map(mapExecution),
      connectorSources: (connectorSources as unknown as Record<string, unknown>[]).map(mapConnectorSource),
    }));
  } catch {
    return jsonError("Failed to fetch sales dashboard", 500);
  }
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json();
    const hiveId = cleanString(body.hiveId);
    const goal = cleanString(body.goal);
    const segmentName = cleanString(body.segmentName);
    const customerType = CUSTOMER_TYPES.has(body.customerType) ? body.customerType as "lead" | "customer" | "dormant_customer" : "lead";
    const metrics = cleanMetrics(body.metrics);

    if (!isUuid(hiveId)) return jsonError("hiveId must be a UUID", 400);
    if (!goal || !segmentName) return jsonError("goal and segmentName are required", 400);
    if (!(await ensureCanMutateHive(authz.user, hiveId))) return jsonError("Forbidden: caller cannot manage this hive", 403);

    const plan = createSalesOperatingPlan({ hiveId, goal, segment: { name: segmentName, source: "manual_import", customerType }, metrics });
    const created = await sql.begin(async (tx) => {
      const segmentRows = await tx`
        INSERT INTO sales_segments (hive_id, name, source, customer_type)
        VALUES (${hiveId}, ${segmentName}, 'manual_import', ${customerType})
        RETURNING id
      `;
      const segmentId = (segmentRows[0] as { id: string }).id;
      const funnelRows = await tx`
        INSERT INTO sales_funnels (hive_id, segment_id, goal, stages, biggest_leak, source)
        VALUES (${hiveId}, ${segmentId}, ${goal}, ${JSON.stringify(plan.funnel.stages)}::jsonb,
                ${JSON.stringify(plan.bottleneck)}::jsonb, 'manual_import')
        RETURNING id
      `;
      const funnelId = (funnelRows[0] as { id: string }).id;
      const actionPlanRows = await tx`
        INSERT INTO sales_action_plans (hive_id, funnel_id, bottleneck, status, bounded_by, approval_policy, next_measurement)
        VALUES (${hiveId}, ${funnelId}, ${JSON.stringify(plan.bottleneck)}::jsonb, 'draft', ${plan.actionPlan.boundedBy},
                ${JSON.stringify(plan.actionPlan.approvalPolicy)}::jsonb, ${plan.actionPlan.nextMeasurement})
        RETURNING id
      `;
      const actionPlanId = (actionPlanRows[0] as { id: string }).id;
      const draftPayload = plan.actionDrafts.map((draft) => ({
        workflow: draft.workflow,
        title: draft.title,
        draftBody: draft.draftBody,
        requestPayload: { domain: "sales-conversion", actionPlanId, workflow: draft.workflow, title: draft.title, draftBody: draft.draftBody },
        executionMetadata: { mode: "manual_queue", domain: "sales-conversion", actionPlanId, workflow: draft.workflow },
      }));
      const actionDraftRows = await tx`
        WITH payload AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(draftPayload)}::jsonb)
            AS x(workflow text, title text, "draftBody" text, "requestPayload" jsonb, "executionMetadata" jsonb)
        ), action_requests AS (
          INSERT INTO external_action_requests (hive_id, connector, operation, state, requested_by, request_payload, policy_snapshot, execution_metadata)
          SELECT ${hiveId}, 'manual_queue', 'execute_sales_conversion_action', 'awaiting_approval', ${authz.user.id}, "requestPayload",
                 ${JSON.stringify({ outboundCustomerActions: "owner_approval_required" })}::jsonb, "executionMetadata"
          FROM payload
          RETURNING id, request_payload
        ), approval_decisions AS (
          INSERT INTO decisions (hive_id, title, context, recommendation, options, priority, status, kind, route_metadata)
          SELECT ${hiveId}, 'Approve sales conversion action?',
                 'Sales OS outbound customer action requires owner approval before execution or connector queueing.',
                 'Approve only if the message/script is appropriate for this customer segment and bounded conversion fix.',
                 ${JSON.stringify([{ key: "approve", label: "Approve", consequence: "Queue this sales action." }, { key: "reject", label: "Reject", consequence: "Block this sales action." }])}::jsonb,
                 'normal', 'pending', 'external_action_approval',
                 jsonb_build_object('externalActionRequestId', ar.id, 'operation', 'execute_sales_conversion_action', 'domain', 'sales-conversion', 'executionMode', 'manual_queue')
          FROM action_requests ar
          RETURNING id, route_metadata
        ), linked_requests AS (
          UPDATE external_action_requests ear
          SET decision_id = ad.id, updated_at = now()
          FROM approval_decisions ad
          WHERE ear.id = (ad.route_metadata->>'externalActionRequestId')::uuid
          RETURNING ear.id, ear.request_payload
        )
        INSERT INTO sales_action_drafts (hive_id, action_plan_id, external_action_request_id, workflow, title, draft_body)
        SELECT ${hiveId}, ${actionPlanId}, lr.id, p.workflow, p.title, p."draftBody"
        FROM payload p
        JOIN linked_requests lr ON lr.request_payload->>'title' = p.title
        RETURNING id, hive_id, action_plan_id, external_action_request_id, workflow, title, draft_body, approval_status, execution_status
      `;

      return { segmentId, funnelId, actionPlanId, actionDraftRows };
    });

    return jsonOk({
      funnel: { ...plan.funnel, id: created.funnelId, segmentId: created.segmentId },
      actionPlan: { ...plan.actionPlan, id: created.actionPlanId, funnelId: created.funnelId },
      actionDrafts: (created.actionDraftRows as unknown as Record<string, unknown>[]).map(mapActionDraft),
    }, 201);
  } catch {
    return jsonError("Failed to create sales conversion plan", 500);
  }
}
