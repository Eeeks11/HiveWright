import { canAccessHive, canMutateHive } from "@/auth/users";
import {
  isBuiltinConnectorPlugin,
  listConnectorPlugins,
  listEnabledConnectorPluginSlugsForHive,
} from "@/connectors/registry";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";

interface PluginPatch {
  pluginSlug: string;
  enabled: boolean;
}

export async function GET(request: Request) {
  const hiveId = new URL(request.url).searchParams.get("hiveId")?.trim();
  if (!hiveId) return jsonError("hiveId is required", 400);

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden", 403);
  }

  const enabledSlugs = await listEnabledConnectorPluginSlugsForHive(sql, hiveId);
  return jsonOk(listConnectorPlugins().map((plugin) => ({
    ...plugin,
    enabled: enabledSlugs.has(plugin.slug),
    builtIn: isBuiltinConnectorPlugin(plugin.slug),
  })));
}

export async function PATCH(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = validatePatchBody(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);

  if (!authz.user.isSystemOwner) {
    const canMutate = await canMutateHive(sql, authz.user.id, parsed.hiveId);
    if (!canMutate) return jsonError("Forbidden", 403);
  }

  const knownPlugins = new Set(listConnectorPlugins().map((plugin) => plugin.slug));
  const unknown = parsed.plugins.find((plugin) => !knownPlugins.has(plugin.pluginSlug));
  if (unknown) return jsonError(`unknown connector plugin: ${unknown.pluginSlug}`, 400);

  const builtInChange = parsed.plugins.find((plugin) => isBuiltinConnectorPlugin(plugin.pluginSlug) && !plugin.enabled);
  if (builtInChange) return jsonError("built-in connector plugin cannot be disabled", 400);

  await sql.begin(async (tx) => {
    for (const plugin of parsed.plugins) {
      await tx`
        INSERT INTO hive_connector_plugins (hive_id, plugin_slug, enabled, updated_at)
        VALUES (${parsed.hiveId}::uuid, ${plugin.pluginSlug}, ${plugin.enabled}, NOW())
        ON CONFLICT (hive_id, plugin_slug)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
      `;
    }
  });

  const enabledSlugs = await listEnabledConnectorPluginSlugsForHive(sql, parsed.hiveId);
  return jsonOk(listConnectorPlugins().map((plugin) => ({
    ...plugin,
    enabled: enabledSlugs.has(plugin.slug),
    builtIn: isBuiltinConnectorPlugin(plugin.slug),
  })));
}

function validatePatchBody(body: unknown): { hiveId: string; plugins: PluginPatch[] } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  const candidate = body as { hiveId?: unknown; plugins?: unknown };
  if (typeof candidate.hiveId !== "string" || candidate.hiveId.trim() === "") {
    return { error: "hiveId is required" };
  }
  if (!Array.isArray(candidate.plugins)) return { error: "plugins must be an array" };
  const plugins: PluginPatch[] = [];
  for (const plugin of candidate.plugins) {
    if (!plugin || typeof plugin !== "object") return { error: "each plugin patch must be an object" };
    const row = plugin as { pluginSlug?: unknown; enabled?: unknown };
    if (typeof row.pluginSlug !== "string" || row.pluginSlug.trim() === "") {
      return { error: "pluginSlug is required" };
    }
    if (typeof row.enabled !== "boolean") {
      return { error: "enabled must be boolean" };
    }
    plugins.push({ pluginSlug: row.pluginSlug.trim(), enabled: row.enabled });
  }
  return { hiveId: candidate.hiveId.trim(), plugins };
}
