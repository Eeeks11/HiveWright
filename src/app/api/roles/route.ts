import { sql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { requireStrictHiveTarget } from "../_lib/hive-target";
import { requireApiUser, requireSystemOwner } from "../_lib/auth";
import { applyHiveRoleOverride, loadHiveRoleOverrides, saveHiveRoleOverride } from "../../../roles/hive-overrides";
import { checkRole, listHiveRoles } from "./_service";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const searchParams = new URL(request.url).searchParams;
    const includeInactive = searchParams.get("includeInactive") === "true";
    const target = await requireStrictHiveTarget(sql, authz.user, { kind: "query", request });
    if (target.ok === false) return target.response;
    return jsonOk(await listHiveRoles(target.hiveId, includeInactive));
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
