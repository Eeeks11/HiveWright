import { sql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../_lib/auth";
import { provisionerFor } from "../../../provisioning";
import type { ProvisionStatus } from "../../../provisioning";
import { getCachedStatus, setCachedStatus } from "../../../provisioning/status-cache";
import { AUTO_MODEL_ROUTE } from "../../../model-routing/selector";
import { applyHiveRoleOverride, loadHiveRoleOverrides, saveHiveRoleOverride } from "../../../roles/hive-overrides";

async function checkRole(adapterType: string, slug: string, recommendedModel: string): Promise<ProvisionStatus> {
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

export async function GET(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const searchParams = new URL(request.url).searchParams;
    const includeInactive = searchParams.get("includeInactive") === "true";
    const hiveId = searchParams.get("hiveId");

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

    const data = effectiveRows.map((r, i) => ({
      slug: r.slug, name: r.name, department: r.department, type: r.type,
      delegatesTo: r.delegates_to, recommendedModel: r.recommended_model,
      fallbackModel: r.fallback_model ?? null,
      adapterType: r.adapter_type,
      fallbackAdapterType: r.fallback_adapter_type ?? null,
      skills: r.skills, active: r.active,
      toolsConfig: r.tools_config ?? null,
      concurrencyLimit: r.concurrency_limit ?? 1,
      ownerPinned: r.owner_pinned ?? false,
      activeCount: Number(r.active_count ?? 0),
      runningCount: Number(r.running_count ?? 0),
      provisionStatus: statuses[i],
    }));
    return jsonOk(data);
  } catch { return jsonError("Failed to fetch roles", 500); }
}

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const {
      slug,
      hiveId,
      recommendedModel,
      adapterType,
      fallbackModel,
      fallbackAdapterType,
      toolsConfig,
      concurrencyLimit,
      ownerPinned,
      active,
    } = body;
    if (!slug) return jsonError("slug is required", 400);

    const [existingRole] = await sql`
      SELECT adapter_type, recommended_model, fallback_adapter_type, fallback_model, tools_config
      FROM role_templates
      WHERE slug = ${slug}
      LIMIT 1
    `;
    if (!existingRole) return jsonError("role not found", 404);

    const runtimeFieldsChanged =
      recommendedModel !== undefined ||
      adapterType !== undefined ||
      fallbackModel !== undefined ||
      fallbackAdapterType !== undefined ||
      toolsConfig !== undefined;

    if (hiveId && runtimeFieldsChanged) {
      await saveHiveRoleOverride(sql, hiveId, slug, {
        recommendedModel,
        adapterType,
        fallbackModel: fallbackModel === undefined ? undefined : (fallbackModel || null),
        fallbackAdapterType: fallbackAdapterType === undefined ? undefined : (fallbackAdapterType || null),
        toolsConfig,
      });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (!hiveId) {
      if (recommendedModel !== undefined) { updates.push(`recommended_model = $${idx++}`); values.push(recommendedModel); }
      if (adapterType !== undefined) { updates.push(`adapter_type = $${idx++}`); values.push(adapterType); }
      if (fallbackModel !== undefined) { updates.push(`fallback_model = $${idx++}`); values.push(fallbackModel || null); }
      if (fallbackAdapterType !== undefined) { updates.push(`fallback_adapter_type = $${idx++}`); values.push(fallbackAdapterType || null); }
      if (toolsConfig !== undefined) {
        updates.push(`tools_config = $${idx++}::jsonb`);
        values.push(toolsConfig === null ? null : JSON.stringify(toolsConfig));
      }
    }
    if (concurrencyLimit !== undefined) {
      // Validate: must be a positive integer. UI is a number input; this is
      // belt-and-braces against direct API callers passing rubbish.
      const n = Number(concurrencyLimit);
      if (!Number.isInteger(n) || n < 1) {
        return jsonError("concurrencyLimit must be a positive integer", 400);
      }
      updates.push(`concurrency_limit = $${idx++}`);
      values.push(n);
    }
    if (ownerPinned !== undefined) {
      updates.push(`owner_pinned = $${idx++}`);
      values.push(Boolean(ownerPinned));
    }
    if (active !== undefined) {
      if (typeof active !== "boolean") return jsonError("active must be a boolean", 400);
      updates.push(`active = $${idx++}`);
      values.push(active);
    }

    if (updates.length > 0) {
      values.push(slug);
      await sql.unsafe(`UPDATE role_templates SET ${updates.join(", ")} WHERE slug = $${idx}`, values as string[]);
    } else if (!runtimeFieldsChanged) {
      return jsonError("Nothing to update", 400);
    }

    const [row] = await sql`
      SELECT adapter_type, recommended_model, fallback_adapter_type, fallback_model, tools_config
      FROM role_templates WHERE slug = ${slug}
    `;
    const override = hiveId ? (await loadHiveRoleOverrides(sql, hiveId))[slug] : null;
    const effectiveRole = applyHiveRoleOverride(row ?? existingRole, override);
    const provisionStatus = await checkRole(effectiveRole.adapter_type, slug, effectiveRole.recommended_model ?? "");

    return jsonOk({ slug, updated: true, scopedToHive: Boolean(hiveId), provisionStatus });
  } catch { return jsonError("Failed to update role", 500); }
}
