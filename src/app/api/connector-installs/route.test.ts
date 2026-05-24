import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
    canMutateHive: vi.fn(),
    storeCredential: vi.fn(),
    getConnectorDefinitionForHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/credentials/manager", () => ({
  storeCredential: mocks.storeCredential,
}));

vi.mock("@/connectors/registry", () => ({
  getConnectorDefinitionForHive: mocks.getConnectorDefinitionForHive,
}));

import { GET, PATCH, POST } from "./route";

const connectorDefinition = {
  slug: "discord-webhook",
  name: "Discord webhook",
  setupFields: [
    { key: "webhookUrl", label: "Webhook URL", required: true },
    { key: "defaultUsername", label: "Sender name" },
  ],
  secretFields: ["webhookUrl"],
  scopes: [
    { key: "discord-webhook:test_connection", label: "Test connection", required: true },
    { key: "discord-webhook:send_message", label: "Send message", required: false },
  ],
  operations: [{ slug: "send_message" }],
  capabilities: ["health", "action_execute"],
};

function installRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/connector-installs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("GET /api/connector-installs access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before listing installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/connector-installs?hiveId=hive-a"));

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-members before listing installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/connector-installs?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows hive members to list installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(true);
    mocks.sql.mockResolvedValueOnce([{ id: "install-1", hiveId: "hive-a" }]);

    const res = await GET(new Request("http://localhost/api/connector-installs?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([expect.objectContaining({ id: "install-1", hiveId: "hive-a" })]);
    expect(body.data[0]).not.toHaveProperty("credentialId");
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("returns owner-safe redacted install summaries", async () => {
    mocks.sql.mockResolvedValueOnce([{
      id: "install-1",
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      config: {
        webhookUrl: "https://discord.test/webhook/secret",
        defaultUsername: "HiveWright",
      },
      grantedScopes: ["discord-webhook:test_connection"],
      credentialId: "cred-1",
      status: "active",
      lastTestedAt: null,
      lastError: null,
      createdAt: new Date("2026-05-24T00:00:00.000Z"),
      updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      successes7d: 2,
      errors7d: 1,
    }]);
    mocks.getConnectorDefinitionForHive.mockResolvedValueOnce(connectorDefinition);

    const res = await GET(new Request("http://localhost/api/connector-installs?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0]).toMatchObject({
      id: "install-1",
      connectorSlug: "discord-webhook",
      config: { defaultUsername: "HiveWright" },
      credentialConfigured: true,
      successes7d: 2,
      errors7d: 1,
    });
    expect(JSON.stringify(body.data[0])).not.toContain("discord.test");
    expect(body.data[0]).not.toHaveProperty("credentialId");
  });
});

describe("POST /api/connector-installs access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.getConnectorDefinitionForHive.mockReturnValue(connectorDefinition);
    mocks.storeCredential.mockResolvedValue({ id: "cred-1" });
    mocks.sql.mockResolvedValue([{
      id: "install-1",
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      config: { defaultUsername: "HiveWright" },
      grantedScopes: ["discord-webhook:test_connection", "discord-webhook:send_message"],
      credentialId: "cred-1",
      status: "active",
      lastTestedAt: null,
      lastError: null,
      createdAt: new Date("2026-05-24T00:00:00.000Z"),
      updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    }]);
  });

  it("rejects authenticated non-members before storing secrets or creating installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await POST(installRequest({
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      fields: { webhookUrl: "https://example.test/webhook" },
    }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot mutate this hive");
    expect(mocks.getConnectorDefinitionForHive).not.toHaveBeenCalled();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows hive members to create installs and credential material", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(true);

    const res = await POST(installRequest({
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      fields: {
        webhookUrl: "https://example.test/webhook",
        defaultUsername: "HiveWright",
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toEqual({ id: "install-1", connectorSlug: "discord-webhook" });
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "member-1", "hive-a");
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({ hiveId: "hive-a", value: JSON.stringify({ webhookUrl: "https://example.test/webhook" }) }),
    );
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("persists required and selected granted scopes", async () => {
    const res = await POST(installRequest({
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      fields: { webhookUrl: "https://example.test/webhook" },
      grantedScopes: ["discord-webhook:send_message"],
    }));

    expect(res.status).toBe(201);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.sql.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.stringContaining("granted_scopes"),
    ]));
    expect(mocks.sql.mock.calls[0]).toContainEqual([
      "discord-webhook:test_connection",
      "discord-webhook:send_message",
    ]);
  });

  it("rejects unknown granted scopes before storing secrets", async () => {
    const res = await POST(installRequest({
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      fields: { webhookUrl: "https://example.test/webhook" },
      grantedScopes: ["discord-webhook:delete_everything"],
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/unknown scope/i);
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/connector-installs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.getConnectorDefinitionForHive.mockReturnValue(connectorDefinition);
    mocks.storeCredential.mockResolvedValue({ id: "cred-2" });
    mocks.sql
      .mockResolvedValueOnce([{
        id: "install-1",
        hiveId: "hive-a",
        connectorSlug: "discord-webhook",
        displayName: "Discord",
        config: { defaultUsername: "Old Name" },
        grantedScopes: ["discord-webhook:test_connection", "discord-webhook:send_message"],
        credentialId: "cred-1",
        status: "active",
        lastTestedAt: null,
        lastError: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      }])
      .mockResolvedValueOnce([{
        id: "install-1",
        hiveId: "hive-a",
        connectorSlug: "discord-webhook",
        displayName: "Quiet Discord",
        config: { defaultUsername: "New Name" },
        grantedScopes: ["discord-webhook:test_connection"],
        credentialId: "cred-2",
        status: "disabled",
        lastTestedAt: null,
        lastError: null,
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:01.000Z"),
      }]);
  });

  it("rejects authenticated non-members before updating installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await PATCH(installRequest({
      hiveId: "hive-a",
      installId: "install-1",
      status: "disabled",
    }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot mutate this hive");
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });

  it("updates config, secrets, owner-settable status, and granted scopes", async () => {
    const res = await PATCH(installRequest({
      hiveId: "hive-a",
      installId: "install-1",
      status: "disabled",
      displayName: "Quiet Discord",
      fields: {
        webhookUrl: "https://discord.test/webhook/new",
        defaultUsername: "New Name",
      },
      grantedScopes: [],
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "install-1",
      displayName: "Quiet Discord",
      status: "disabled",
      config: { defaultUsername: "New Name" },
      credentialConfigured: true,
      grantedScopes: ["discord-webhook:test_connection"],
    });
    expect(JSON.stringify(body.data)).not.toContain("discord.test");
    expect(body.data).not.toHaveProperty("credentialId");
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({ hiveId: "hive-a", value: JSON.stringify({ webhookUrl: "https://discord.test/webhook/new" }) }),
    );
  });

  it("rejects owner attempts to set broken status", async () => {
    const res = await PATCH(installRequest({
      hiveId: "hive-a",
      installId: "install-1",
      status: "broken",
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/status must be active or disabled/i);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
