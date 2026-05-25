/**
 * Compatibility facade for the connector registry public API.
 *
 * Connector contracts and runtime plugin registration live in plugin-sdk.ts;
 * built-in connector definitions live in builtins.ts. Existing imports from
 * @/connectors/registry continue to work.
 */

import { BUILTIN_CONNECTOR_PLUGIN_SLUG, builtinConnectorPlugin } from "./builtins";
import {
  createConnectorPluginRegistry,
  type ConnectorPlugin,
  type ConnectorDefinition,
  type ConnectorPluginMetadata,
} from "./plugin-sdk";

export * from "./plugin-sdk";

const defaultConnectorPluginRegistry = createConnectorPluginRegistry([builtinConnectorPlugin]);

export const CONNECTOR_REGISTRY: ConnectorDefinition[] = defaultConnectorPluginRegistry.list();

function refreshCompatibilityRegistry() {
  CONNECTOR_REGISTRY.splice(0, CONNECTOR_REGISTRY.length, ...defaultConnectorPluginRegistry.list());
}

export function registerConnectorPlugin(plugin: ConnectorPlugin): void {
  defaultConnectorPluginRegistry.register(plugin);
  refreshCompatibilityRegistry();
}

export function listConnectorDefinitions(): ConnectorDefinition[] {
  return defaultConnectorPluginRegistry.list();
}

export function getConnectorDefinition(slug: string): ConnectorDefinition | undefined {
  return defaultConnectorPluginRegistry.get(slug);
}

export function listConnectorPlugins(): ConnectorPluginMetadata[] {
  return defaultConnectorPluginRegistry.listPlugins();
}

export function isBuiltinConnectorPlugin(pluginSlug: string): boolean {
  return pluginSlug === BUILTIN_CONNECTOR_PLUGIN_SLUG;
}

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export async function listEnabledConnectorPluginSlugsForHive(sql: SqlTag, hiveId: string): Promise<Set<string>> {
  const rows = await (sql`
    SELECT plugin_slug, enabled
    FROM hive_connector_plugins
    WHERE hive_id = ${hiveId}::uuid
  ` as Promise<Array<{ plugin_slug: string; enabled: boolean }>>);
  const enabled = new Set<string>([BUILTIN_CONNECTOR_PLUGIN_SLUG]);
  for (const row of rows) {
    if (row.plugin_slug === BUILTIN_CONNECTOR_PLUGIN_SLUG) continue;
    if (row.enabled) enabled.add(row.plugin_slug);
  }
  return enabled;
}

export async function listConnectorDefinitionsForHive(sql: SqlTag, hiveId: string): Promise<ConnectorDefinition[]> {
  const enabled = await listEnabledConnectorPluginSlugsForHive(sql, hiveId);
  return listConnectorDefinitions().filter((definition) => enabled.has(definition.pluginSlug ?? BUILTIN_CONNECTOR_PLUGIN_SLUG));
}

export async function getConnectorDefinitionForHive(sql: SqlTag, hiveId: string, slug: string): Promise<ConnectorDefinition | undefined> {
  const definition = getConnectorDefinition(slug);
  if (!definition) return undefined;
  const pluginSlug = definition.pluginSlug ?? BUILTIN_CONNECTOR_PLUGIN_SLUG;
  if (pluginSlug === BUILTIN_CONNECTOR_PLUGIN_SLUG) return definition;
  const enabled = await listEnabledConnectorPluginSlugsForHive(sql, hiveId);
  return enabled.has(pluginSlug) ? definition : undefined;
}

export async function isConnectorPluginEnabledForHive(sql: SqlTag, hiveId: string, pluginSlug: string): Promise<boolean> {
  if (pluginSlug === BUILTIN_CONNECTOR_PLUGIN_SLUG) return true;
  const enabled = await listEnabledConnectorPluginSlugsForHive(sql, hiveId);
  return enabled.has(pluginSlug);
}
