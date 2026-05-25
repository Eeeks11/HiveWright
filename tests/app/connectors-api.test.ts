import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canAccessHive: vi.fn(),
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

const { GET } = await import("@/app/api/connectors/route");

describe("GET /api/connectors", () => {
  it("returns safe public connector capability metadata", async () => {
    mocks.requireApiAuth.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/connectors"));
    const body = await response.json();

    expect(response.status).toBe(200);
    const discord = body.data.find((connector: { slug: string }) => connector.slug === "discord-webhook");
    expect(discord).toEqual(expect.objectContaining({
      slug: "discord-webhook",
      name: expect.any(String),
      category: expect.any(String),
      authType: "webhook",
      scopes: expect.arrayContaining([expect.objectContaining({ key: expect.any(String) })]),
    }));
    expect(discord.setupFields.find((field: { key: string }) => field.key === "webhookUrl")).toEqual(
      expect.objectContaining({ type: "password" }),
    );
    expect(discord.operations[0]).toEqual(expect.objectContaining({
      slug: expect.any(String),
      label: expect.any(String),
      governance: expect.objectContaining({
        effectType: expect.any(String),
        defaultDecision: expect.any(String),
        riskTier: expect.any(String),
        dryRunSupported: expect.any(Boolean),
      }),
      outputSummary: expect.any(String),
    }));
    expect(JSON.stringify(discord)).not.toContain("handler");
  });

  it("filters runtime plugin connectors unless enabled for the requested hive", async () => {
    const { defineConnectorPlugin, registerConnectorPlugin } = await import("@/connectors/registry");
    registerConnectorPlugin(defineConnectorPlugin({
      slug: "connectors-api-filter-plugin",
      connectors: [{
        slug: "connectors-api-filter-test",
        name: "Connector API filter test",
        category: "other",
        description: "Hidden unless plugin is enabled for the hive.",
        authType: "none",
        setupFields: [],
        secretFields: [],
        operations: [],
      }],
    }));

    mocks.requireApiUser.mockResolvedValue({ user: { id: "user-1", isSystemOwner: false } });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([]);

    const hidden = await GET(new Request("http://localhost/api/connectors?hiveId=00000000-0000-0000-0000-000000000001"));
    expect((await hidden.json()).data.some((connector: { slug: string }) => connector.slug === "connectors-api-filter-test")).toBe(false);

    mocks.sql.mockResolvedValueOnce([{ plugin_slug: "connectors-api-filter-plugin", enabled: true }]);
    const visible = await GET(new Request("http://localhost/api/connectors?hiveId=00000000-0000-0000-0000-000000000001"));
    expect((await visible.json()).data.some((connector: { slug: string }) => connector.slug === "connectors-api-filter-test")).toBe(true);
  });
});
