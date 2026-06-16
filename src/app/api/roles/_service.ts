import { sql } from "../_lib/db";
import { provisionerFor } from "../../../provisioning";
import type { ProvisionStatus } from "../../../provisioning";
import { getCachedStatus, setCachedStatus } from "../../../provisioning/status-cache";
import { AUTO_MODEL_ROUTE } from "../../../model-routing/selector";
import { applyHiveRoleOverride, loadHiveRoleOverrides } from "../../../roles/hive-overrides";

export async function checkRole(adapterType: string, slug: string, recommendedModel: string): Promise<ProvisionStatus> {
  if (adapterType === AUTO_MODEL_ROUTE || recommendedModel === AUTO_MODEL_ROUTE) {
    return {
      satisfied: true,
      fixable: false,
      reason: "automatic model routing is configured",
    };
  }

  const cached = getCachedStatus(slug);
  if (cached) return cached;

  const provisioner = provisionerFor(adapterType);
  if (!provisioner) {
    return { satisfied: false, fixable: false, reason: `unsupported adapter '${adapterType}'` };
  }
  try {
    const status = await provisioner.check({ slug, recommendedModel });
    setCachedStatus(slug, status);
    return status;
  } catch (e) {
    // Errors NOT cached — transient GPU hiccup shouldn't pin yellow for 60s.
    return { satisfied: false, fixable: false, reason: `check failed: ${(e as Error).message}` };
  }
}

function serializeRoleRow(row: Record<string, unknown>, provisionStatus: ProvisionStatus) {
  return {
    slug: row.slug,
    name: row.name,
    department: row.department,
    type: row.type,
    delegatesTo: row.delegates_to,
    recommendedModel: row.recommended_model,
    fallbackModel: row.fallback_model ?? null,
    adapterType: row.adapter_type,
    fallbackAdapterType: row.fallback_adapter_type ?? null,
    skills: row.skills,
    active: row.active,
    toolsConfig: row.tools_config ?? null,
    concurrencyLimit: row.concurrency_limit ?? 1,
    ownerPinned: row.owner_pinned ?? false,
    activeCount: Number(row.active_count ?? 0),
    runningCount: Number(row.running_count ?? 0),
    provisionStatus,
  };
}

export async function listHiveRoles(hiveId: string, includeInactive: boolean) {
  const rows = await sql`
    SELECT
      rt.slug,
      rt.name,
      rt.department,
      rt.type,
      rt.delegates_to,
      rt.recommended_model,
      rt.fallback_model,
      rt.adapter_type,
      rt.fallback_adapter_type,
      rt.skills,
      rt.active,
      rt.tools_config,
      rt.concurrency_limit,
      rt.owner_pinned,
      COALESCE(counts.active_count, 0)::int AS active_count,
      COALESCE(counts.running_count, 0)::int AS running_count
    FROM role_templates rt
    LEFT JOIN (
      SELECT
        assigned_to,
        COUNT(*) FILTER (WHERE status IN ('pending', 'active')) AS active_count,
        COUNT(*) FILTER (WHERE status = 'active') AS running_count
      FROM tasks
      WHERE hive_id = ${hiveId}
      GROUP BY assigned_to
    ) counts ON counts.assigned_to = rt.slug
    ${includeInactive ? sql`` : sql`WHERE rt.active = true`}
    ORDER BY rt.department ASC, rt.name ASC
  `;

  const overrides = await loadHiveRoleOverrides(sql, hiveId);
  const effectiveRows = rows.map((row) => applyHiveRoleOverride(row, overrides[row.slug]));

  const statuses = await Promise.all(
    effectiveRows.map((r) => checkRole(r.adapter_type, r.slug, r.recommended_model ?? "")),
  );

  return effectiveRows.map((row, index) => serializeRoleRow(row, statuses[index]));
}

export async function listGlobalRoleTemplates(includeInactive: boolean) {
  const rows = await sql`
    SELECT
      rt.slug,
      rt.name,
      rt.department,
      rt.type,
      rt.delegates_to,
      rt.recommended_model,
      rt.fallback_model,
      rt.adapter_type,
      rt.fallback_adapter_type,
      rt.skills,
      rt.active,
      rt.tools_config,
      rt.concurrency_limit,
      rt.owner_pinned,
      0::int AS active_count,
      0::int AS running_count
    FROM role_templates rt
    ${includeInactive ? sql`` : sql`WHERE rt.active = true`}
    ORDER BY rt.department ASC, rt.name ASC
  `;

  const statuses = await Promise.all(
    rows.map((r) => checkRole(r.adapter_type, r.slug, r.recommended_model ?? "")),
  );

  return rows.map((row, index) => serializeRoleRow(row, statuses[index]));
}
