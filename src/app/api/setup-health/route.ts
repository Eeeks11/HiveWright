import { HIVES_WORKSPACE_ROOT_ENV, resolveHiveWorkspaceRoot } from "@/hives/workspace-root";
import { defaultEnvFilePath, upsertEnvFileValue } from "@/lib/env-file";
import { canAccessHive } from "@/auth/users";
import { buildSetupHealthRows, type SetupHealthSnapshot } from "@/setup-health/status";
import { getHiveOperatorVerdict } from "@/operations/operator-verdict";
import { sql } from "../_lib/db";
import { requireApiAuth, requireApiUser, requireSystemOwner } from "../_lib/auth";
import { jsonError, jsonOk } from "../_lib/responses";

type DashboardReachability = SetupHealthSnapshot["dashboard"];

const DASHBOARD_REACHABILITY_TIMEOUT_MS = 1200;

export async function GET(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const requestUrl = new URL(request.url);
  const hiveId = requestUrl.searchParams.get("hiveId");
  if (hiveId) {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    try {
      const [snapshot, dashboard, operatorVerdict] = await Promise.all([
        loadSetupHealthSnapshot(hiveId),
        checkDashboardReachability(requestUrl),
        getHiveOperatorVerdict(sql, { hiveId }),
      ]);
      const snapshotWithDashboard = { ...snapshot, dashboard };
      return jsonOk({
        hiveId,
        rows: buildSetupHealthRows(snapshotWithDashboard),
        dashboard,
        operatorVerdict,
        sources: {
          models: "model_catalog, hive_models, model_health, and role_templates",
          ea: "connector_installs for the EA connector",
          dispatcher: "dispatcher settings plus current task counts",
          connectors: "connector_installs and connector test fields",
          safety: "action_policies safety presets and approval rules",
          schedules: "schedules",
          memory: "memory-search setting plus embedding_config",
        },
      });
    } catch (err) {
      console.error("[setup-health GET] failed:", err);
      return jsonError("Failed to load setup health", 500);
    }
  }

  const dashboard = await checkDashboardReachability(requestUrl);
  return jsonOk({
    hiveWorkspaceRoot: resolveHiveWorkspaceRoot(),
    envKey: HIVES_WORKSPACE_ROOT_ENV,
    envFilePath: defaultEnvFilePath(),
    restartRequired: false,
    dashboard,
  });
}

export async function PATCH(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  try {
    const body = await request.json() as { hiveWorkspaceRoot?: unknown };
    const requested = typeof body.hiveWorkspaceRoot === "string"
      ? body.hiveWorkspaceRoot.trim()
      : "";
    if (!requested) return jsonError("hiveWorkspaceRoot is required", 400);

    const nextRoot = resolveHiveWorkspaceRoot({ HIVES_WORKSPACE_ROOT: requested });
    const written = upsertEnvFileValue(HIVES_WORKSPACE_ROOT_ENV, nextRoot);
    return jsonOk({
      hiveWorkspaceRoot: nextRoot,
      envKey: HIVES_WORKSPACE_ROOT_ENV,
      envFilePath: written.envFilePath,
      restartRequired: true,
      restartMessage: "Restart the dispatcher and app for HIVES_WORKSPACE_ROOT to take effect.",
    });
  } catch (err) {
    console.error("[setup-health PATCH] failed:", err);
    return jsonError("Failed to update hive workspace root", 500);
  }
}

async function loadSetupHealthSnapshot(hiveId: string): Promise<Omit<SetupHealthSnapshot, "dashboard">> {
  const [
    [roles],
    [ea],
    [dispatcherConfig],
    [tasks],
    [connectors],
    [actionPolicies],
    [schedules],
    [memoryConfig],
    [embeddingConfig],
  ] = await Promise.all([
    sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE COALESCE(adapter_type, '') <> ''
            AND COALESCE(recommended_model, '') <> ''
        )::int AS configured
      FROM role_templates
      WHERE active = true
    `,
    sql`
      SELECT
        COUNT(*)::int AS installed,
        COUNT(*) FILTER (WHERE status <> 'active')::int AS disabled,
        COUNT(*) FILTER (WHERE last_tested_at IS NOT NULL)::int AS tested,
        COUNT(*) FILTER (WHERE last_error IS NOT NULL AND last_error <> '')::int AS errors
      FROM connector_installs
      WHERE hive_id = ${hiveId}::uuid
        AND connector_slug = 'ea-discord'
    `,
    sql`
      SELECT config
      FROM adapter_config
      WHERE adapter_type = 'dispatcher'
        AND (hive_id = ${hiveId}::uuid OR hive_id IS NULL)
      ORDER BY hive_id NULLS LAST, updated_at DESC
      LIMIT 1
    `,
    sql`
      SELECT COUNT(*)::int AS open
      FROM tasks
      WHERE hive_id = ${hiveId}::uuid
        AND status IN ('pending', 'active')
    `,
    sql`
      SELECT
        COUNT(*)::int AS installed,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'active' AND last_tested_at IS NOT NULL)::int AS tested,
        COUNT(*) FILTER (WHERE last_error IS NOT NULL AND last_error <> '')::int AS errors
      FROM connector_installs
      WHERE hive_id = ${hiveId}::uuid
        AND connector_slug <> 'ea-discord'
    `,
    sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE enabled = true)::int AS enabled,
        COUNT(*) FILTER (
          WHERE enabled = true
            AND effect_type = 'destructive'
            AND effect = 'block'
        )::int AS blocks_destructive,
        COUNT(*) FILTER (
          WHERE enabled = true
            AND effect_type IN ('notify', 'write', 'financial', 'system')
            AND effect IN ('require_approval', 'block')
        )::int AS approval_external
      FROM action_policies
      WHERE hive_id = ${hiveId}::uuid
    `,
    sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE enabled = true)::int AS enabled
      FROM schedules
      WHERE hive_id = ${hiveId}::uuid
    `,
    sql`
      SELECT config
      FROM adapter_config
      WHERE adapter_type = 'memory-search'
        AND (hive_id = ${hiveId}::uuid OR hive_id IS NULL)
      ORDER BY hive_id NULLS LAST, updated_at DESC
      LIMIT 1
    `,
    sql`
      SELECT status, last_error
      FROM embedding_config
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
  ]);

  const dispatcherSettings = asRecord(dispatcherConfig?.config);
  const memorySettings = asRecord(memoryConfig?.config);
  const memoryEnabled = memorySettings.enabled === true || memorySettings.prepareOnSetup === true;

  return {
    roles: {
      total: Number(roles?.total ?? 0),
      configured: Number(roles?.configured ?? 0),
    },
    ea: {
      installed: Number(ea?.installed ?? 0) > 0,
      disabled: Number(ea?.disabled ?? 0) > 0,
      lastTested: Number(ea?.tested ?? 0) > 0,
      hasError: Number(ea?.errors ?? 0) > 0,
    },
    dispatcher: {
      configured: Boolean(dispatcherConfig),
      maxConcurrentAgents: typeof dispatcherSettings.maxConcurrentTasks === "number"
        ? dispatcherSettings.maxConcurrentTasks
        : null,
      openTasks: Number(tasks?.open ?? 0),
    },
    connectors: {
      installed: Number(connectors?.installed ?? 0),
      active: Number(connectors?.active ?? 0),
      tested: Number(connectors?.tested ?? 0),
      withErrors: Number(connectors?.errors ?? 0),
    },
    actionPolicies: {
      total: Number(actionPolicies?.total ?? 0),
      enabled: Number(actionPolicies?.enabled ?? 0),
      blocksDestructive: Number(actionPolicies?.blocks_destructive ?? 0) > 0,
      requiresApprovalForExternalWrites: Number(actionPolicies?.approval_external ?? 0) >= 3,
    },
    schedules: {
      total: Number(schedules?.total ?? 0),
      enabled: Number(schedules?.enabled ?? 0),
    },
    memory: {
      requested: Boolean(memoryConfig) && memoryEnabled,
      disabled: Boolean(memoryConfig) && memorySettings.enabled === false,
      embeddingConfigured: Boolean(embeddingConfig),
      embeddingStatus: embeddingConfig?.status ? String(embeddingConfig.status) : null,
      embeddingError: Boolean(embeddingConfig?.last_error),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function checkDashboardReachability(requestUrl: URL): Promise<DashboardReachability> {
  const checkedUrls = resolveDashboardUrlCandidates(requestUrl);
  let lastError: string | null = null;

  for (const dashboardUrl of checkedUrls) {
    try {
      const res = await fetch(new URL("/", dashboardUrl).toString(), {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(DASHBOARD_REACHABILITY_TIMEOUT_MS),
      });
      if (res.status < 500) {
        return { checkedUrls, reachableUrl: dashboardUrl, lastError: null };
      }
      lastError = `HTTP ${res.status} from ${dashboardUrl}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { checkedUrls, reachableUrl: null, lastError };
}

function resolveDashboardUrlCandidates(requestUrl: URL): string[] {
  return uniqueUrls([
    process.env.NEXT_PUBLIC_DASHBOARD_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.HIVEWRIGHT_INTERNAL_BASE_URL,
    process.env.AUTH_URL,
    process.env.NEXTAUTH_URL,
    process.env.BASE_URL,
    isLocalHttpOrigin(requestUrl.origin) && requestUrl.port ? requestUrl.origin : null,
    process.env.PORT ? `http://localhost:${process.env.PORT}` : null,
    "http://localhost:3002",
  ]);
}

function uniqueUrls(values: Array<string | null | undefined>): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeHttpOrigin(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

function normalizeHttpOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLocalHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
