import { describe, expect, it } from "vitest";
import {
  createConnectorPluginRegistry,
  defineConnectorPlugin,
  getConnectorDefinition,
  getConnectorDefinitionForHive,
  listConnectorDefinitions,
  listConnectorDefinitionsForHive,
  registerConnectorPlugin,
  toPublicConnector,
  type ConnectorDefinitionDraft,
} from "@/connectors/registry";

function connectorDraft(slug: string): ConnectorDefinitionDraft {
  return {
    slug,
    name: `Test ${slug}`,
    category: "other",
    description: "A connector used by plugin SDK tests.",
    authType: "none",
    setupFields: [
      { key: "token", label: "Token", type: "text", required: true },
    ],
    secretFields: ["token"],
    operations: [
      {
        slug: "write_thing",
        label: "Write thing",
        args: [{ key: "message", label: "Message", type: "text", required: true }],
        inputSchema: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", description: "Message to write" },
          },
        },
        outputSummary: "Writes a test thing for plugin SDK coverage.",
        governance: {
          effectType: "write",
          defaultDecision: "require_approval",
          riskTier: "medium",
          summary: "Writes a test thing.",
          dryRunSupported: true,
          externalSideEffect: true,
        },
        handler: async () => ({ ok: true }),
      },
    ],
  };
}

describe("connector plugin SDK registry", () => {
  it("rejects duplicate connector slugs", () => {
    expect(() => createConnectorPluginRegistry([
      defineConnectorPlugin({
        slug: "single-plugin-with-duplicate-connectors",
        connectors: [
          connectorDraft("duplicate-in-plugin-test"),
          connectorDraft("duplicate-in-plugin-test"),
        ],
      }),
    ])).toThrow(/already registered: duplicate-in-plugin-test/);

    const registry = createConnectorPluginRegistry();
    registry.register(defineConnectorPlugin({
      slug: "first-plugin",
      connectors: [connectorDraft("duplicate-plugin-test")],
    }));

    expect(() => registry.register(defineConnectorPlugin({
      slug: "second-plugin",
      connectors: [connectorDraft("duplicate-plugin-test")],
    }))).toThrow(/already registered: duplicate-plugin-test/);
  });

  it("preserves generated test_connection, generated scopes, and governance defaults", () => {
    const registry = createConnectorPluginRegistry([
      defineConnectorPlugin({
        slug: "governance-plugin",
        connectors: [connectorDraft("plugin-governance-test")],
      }),
    ]);

    const connector = registry.get("plugin-governance-test");
    expect(connector).toBeDefined();
    expect(connector?.operations.map((op) => op.slug)).toEqual(["test_connection", "write_thing"]);

    const testOperation = connector?.operations.find((op) => op.slug === "test_connection");
    expect(testOperation?.governance).toMatchObject({
      effectType: "system",
      defaultDecision: "allow",
      riskTier: "low",
      scopes: ["plugin-governance-test:test_connection"],
      dryRunSupported: false,
      externalSideEffect: false,
    });

    const writeOperation = connector?.operations.find((op) => op.slug === "write_thing");
    expect(writeOperation?.governance).toMatchObject({
      effectType: "write",
      defaultDecision: "require_approval",
      riskTier: "medium",
      scopes: ["plugin-governance-test:write_thing"],
    });
    expect(connector?.scopes.map((scope) => scope.key)).toEqual([
      "plugin-governance-test:test_connection",
      "plugin-governance-test:write_thing",
    ]);
    expect(connector?.scopes.map((scope) => scope.kind)).toEqual(["read", "write"]);
    expect(connector?.capabilities).toEqual(["health", "action_execute"]);
  });

  it("preserves explicit non-action capability families", () => {
    const registry = createConnectorPluginRegistry([
      defineConnectorPlugin({
        slug: "sync-plugin",
        connectors: [{
          ...connectorDraft("plugin-sync-test"),
          capabilities: ["sync", "record_import"],
        }],
      }),
    ]);

    expect(registry.get("plugin-sync-test")?.capabilities).toEqual([
      "health",
      "sync",
      "record_import",
      "action_execute",
    ]);
  });

  it("makes runtime registered connectors discoverable through the compatibility facade", () => {
    const slug = "runtime-plugin-test";
    expect(getConnectorDefinition(slug)).toBeUndefined();

    registerConnectorPlugin(defineConnectorPlugin({
      slug: "runtime-test-plugin",
      connectors: [connectorDraft(slug)],
    }));

    const connector = getConnectorDefinition(slug);
    expect(connector?.slug).toBe(slug);
    expect(listConnectorDefinitions().some((definition) => definition.slug === slug)).toBe(true);

    const publicConnector = toPublicConnector(connector!);
    expect(publicConnector.setupFields[0]).toMatchObject({
      key: "token",
      type: "password",
      placeholder: "[REDACTED]",
    });
    expect("handler" in publicConnector.operations[0]).toBe(false);
    expect(publicConnector.capabilities).toEqual(["health", "action_execute"]);
  });

  it("filters connector definitions by hive-enabled plugin slugs", async () => {
    const slug = "hive-enabled-plugin-test";
    registerConnectorPlugin(defineConnectorPlugin({
      slug: "hive-enabled-test-plugin",
      connectors: [connectorDraft(slug)],
    }));

    const disabledSql = (async () => []) as Parameters<typeof listConnectorDefinitionsForHive>[0];
    const enabledSql = (async () => [{ plugin_slug: "hive-enabled-test-plugin", enabled: true }]) as Parameters<typeof listConnectorDefinitionsForHive>[0];

    expect((await listConnectorDefinitionsForHive(disabledSql, "00000000-0000-0000-0000-000000000001"))
      .some((definition) => definition.slug === slug)).toBe(false);
    expect(await getConnectorDefinitionForHive(disabledSql, "00000000-0000-0000-0000-000000000001", slug)).toBeUndefined();

    expect((await listConnectorDefinitionsForHive(enabledSql, "00000000-0000-0000-0000-000000000001"))
      .some((definition) => definition.slug === slug)).toBe(true);
    expect((await getConnectorDefinitionForHive(enabledSql, "00000000-0000-0000-0000-000000000001", slug))?.slug).toBe(slug);
  });
});
