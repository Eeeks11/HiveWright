import { describe, expect, it, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  createConnectorInstall,
  listConnectorInstalls,
  redactConnectorInstallForOwner,
  updateConnectorInstall,
} from "@/connectors/installs";
import { getConnectorDefinition } from "@/connectors/registry";

const HIVE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TEST_ENCRYPTION_KEY = "0".repeat(64);

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'install-test-hive', 'Install Test Hive', 'digital')
  `;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

describe("connector install domain helpers", () => {
  it("creates installs with redacted config and required scopes", async () => {
    const install = await createConnectorInstall(sql, {
      hiveId: HIVE_ID,
      connectorSlug: "discord-webhook",
      displayName: "Owner Discord",
      fields: {
        webhookUrl: "https://discord.test/webhook/secret",
        defaultUsername: "HiveWright",
      },
      grantedScopes: ["discord-webhook:send_message"],
    });

    const [row] = await sql<{
      id: string;
      config: Record<string, unknown>;
      granted_scopes: string[];
      credential_id: string | null;
    }[]>`
      SELECT id, config, granted_scopes, credential_id
      FROM connector_installs
      WHERE id = ${install.id}
    `;

    expect(row.config).toEqual({ defaultUsername: "HiveWright" });
    expect(JSON.stringify(row.config)).not.toContain("discord.test");
    expect(row.credential_id).toEqual(expect.any(String));
    expect(row.granted_scopes).toEqual([
      "discord-webhook:test_connection",
      "discord-webhook:send_message",
    ]);
    expect(install).toMatchObject({
      id: row.id,
      connectorSlug: "discord-webhook",
      credentialConfigured: true,
      config: { defaultUsername: "HiveWright" },
    });
    expect(JSON.stringify(install)).not.toContain("discord.test");
    expect(install).not.toHaveProperty("credentialId");
  });

  it("rejects unknown scopes before storing an install", async () => {
    await expect(createConnectorInstall(sql, {
      hiveId: HIVE_ID,
      connectorSlug: "discord-webhook",
      displayName: "Owner Discord",
      fields: { webhookUrl: "https://discord.test/webhook/secret" },
      grantedScopes: ["discord-webhook:delete_everything"],
    })).rejects.toThrow(/unknown scope/i);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM connector_installs
    `;
    expect(count).toBe(0);
  });

  it("updates owner-editable config, status, and scopes without exposing secrets", async () => {
    const install = await createConnectorInstall(sql, {
      hiveId: HIVE_ID,
      connectorSlug: "discord-webhook",
      displayName: "Owner Discord",
      fields: {
        webhookUrl: "https://discord.test/webhook/old",
        defaultUsername: "Old Name",
      },
      grantedScopes: ["discord-webhook:send_message"],
    });

    const updated = await updateConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId: install.id,
      status: "disabled",
      displayName: "Quiet Discord",
      fields: {
        webhookUrl: "https://discord.test/webhook/new",
        defaultUsername: "New Name",
      },
      grantedScopes: [],
    });

    expect(updated).toMatchObject({
      id: install.id,
      displayName: "Quiet Discord",
      status: "disabled",
      credentialConfigured: true,
      config: { defaultUsername: "New Name" },
      grantedScopes: ["discord-webhook:test_connection"],
    });
    expect(JSON.stringify(updated)).not.toContain("discord.test");

    const [row] = await sql<{ config: Record<string, unknown>; granted_scopes: string[]; status: string }[]>`
      SELECT config, granted_scopes, status FROM connector_installs WHERE id = ${install.id}
    `;
    expect(row.config).toEqual({ defaultUsername: "New Name" });
    expect(row.granted_scopes).toEqual(["discord-webhook:test_connection"]);
    expect(row.status).toBe("disabled");
  });

  it("redacts legacy rows that accidentally contain secret fields", () => {
    const definition = getConnectorDefinition("discord-webhook");
    expect(definition).toBeDefined();

    const redacted = redactConnectorInstallForOwner({
      id: "install-1",
      hiveId: HIVE_ID,
      connectorSlug: "discord-webhook",
      displayName: "Legacy Discord",
      config: {
        webhookUrl: "https://discord.test/webhook/leaked",
        defaultUsername: "HiveWright",
      },
      grantedScopes: ["discord-webhook:test_connection"],
      credentialId: "cred-1",
      status: "active",
      lastTestedAt: null,
      lastError: null,
      createdAt: new Date("2026-05-24T00:00:00.000Z"),
      updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    }, definition!);

    expect(redacted.config).toEqual({ defaultUsername: "HiveWright" });
    expect(redacted.credentialConfigured).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain("discord.test");
    expect(redacted).not.toHaveProperty("credentialId");
  });

  it("lists installs as owner-safe summaries with event counts and last sync", async () => {
    const install = await createConnectorInstall(sql, {
      hiveId: HIVE_ID,
      connectorSlug: "discord-webhook",
      displayName: "Owner Discord",
      fields: { webhookUrl: "https://discord.test/webhook/secret" },
    });
    await sql`
      INSERT INTO connector_events (install_id, operation, status)
      VALUES (${install.id}, 'test_connection', 'success'), (${install.id}, 'send_message', 'error')
    `;
    await sql`
      INSERT INTO connector_sync_cursors (install_id, stream, cursor, last_synced_at, last_error)
      VALUES
        (${install.id}, 'default', 'cur-1', ${new Date("2026-05-20T10:00:00.000Z")}, null),
        (${install.id}, 'finance', 'cur-2', ${new Date("2026-05-21T10:00:00.000Z")}, 'token=secret failed')
    `;

    const installs = await listConnectorInstalls(sql, { hiveId: HIVE_ID });

    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      id: install.id,
      connectorSlug: "discord-webhook",
      credentialConfigured: true,
      successes7d: 1,
      errors7d: 1,
      lastSyncedAt: new Date("2026-05-21T10:00:00.000Z"),
      lastSyncError: "token=[REDACTED] failed",
    });
    expect(JSON.stringify(installs[0])).not.toContain("discord.test");
    expect(JSON.stringify(installs[0])).not.toContain("secret");
    expect(installs[0]).not.toHaveProperty("credentialId");
  });
});
