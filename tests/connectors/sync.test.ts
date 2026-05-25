import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { defineConnectorPlugin, registerConnectorPlugin } from "@/connectors/registry";
import { syncConnectorInstall } from "@/connectors/sync";
import { listRecentHiveRecords } from "@/hives/records";

const HIVE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OTHER_HIVE_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const syncHandler = vi.fn();

registerConnectorPlugin(defineConnectorPlugin({
  slug: "sync-runner-test-plugin",
  connectors: [{
    slug: "sync-runner-test",
    name: "Sync Runner Test",
    category: "other",
    description: "Connector used by sync runner tests.",
    authType: "none",
    setupFields: [],
    secretFields: [],
    capabilities: ["sync", "record_import"],
    operations: [
      {
        slug: "sync",
        label: "Sync",
        inputSchema: {
          type: "object",
          required: ["stream"],
          properties: {
            stream: { type: "string" },
            cursor: { type: "string" },
          },
        },
        outputSummary: "Returns normalized sync items for one stream.",
        governance: {
          effectType: "read",
          defaultDecision: "allow",
          riskTier: "low",
          summary: "Imports normalized test records.",
          externalSideEffect: false,
        },
        handler: syncHandler,
      },
    ],
  }],
}));

registerConnectorPlugin(defineConnectorPlugin({
  slug: "unsafe-sync-runner-test-plugin",
  connectors: [{
    slug: "unsafe-sync-runner-test",
    name: "Unsafe Sync Runner Test",
    category: "other",
    description: "Connector used to verify sync operation governance.",
    authType: "none",
    setupFields: [],
    secretFields: [],
    capabilities: ["sync"],
    operations: [
      {
        slug: "sync",
        label: "Unsafe Sync",
        inputSchema: {
          type: "object",
          properties: {
            stream: { type: "string" },
          },
        },
        outputSummary: "Unsafe sync output.",
        governance: {
          effectType: "write",
          defaultDecision: "require_approval",
          riskTier: "medium",
          summary: "Unsafe test operation.",
          externalSideEffect: true,
        },
        handler: async () => ({ stream: "default", items: [] }),
      },
    ],
  }],
}));

beforeEach(async () => {
  await truncateAll(sql);
  syncHandler.mockReset();
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_ID}, 'sync-runner-hive', 'Sync Runner Hive', 'digital'),
      (${OTHER_HIVE_ID}, 'other-sync-runner-hive', 'Other Sync Runner Hive', 'digital')
  `;
});

async function insertInstall(input: {
  hiveId?: string;
  connectorSlug?: string;
  status?: string;
  grantedScopes?: string[];
} = {}): Promise<string> {
  const connectorSlug = input.connectorSlug ?? "sync-runner-test";
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO connector_installs (
      hive_id, connector_slug, display_name, config, granted_scopes, status
    )
    VALUES (
      ${input.hiveId ?? HIVE_ID}::uuid,
      ${connectorSlug},
      'Sync Runner Test',
      ${sql.json({})},
      ${sql.json(input.grantedScopes ?? [`${connectorSlug}:test_connection`, `${connectorSlug}:sync`])},
      ${input.status ?? "active"}
    )
    RETURNING id
  `;
  return row.id;
}

describe("syncConnectorInstall", () => {
  it("loads the current cursor, invokes safe sync operations, and stores the next cursor", async () => {
    const installId = await insertInstall();
    await sql`
      INSERT INTO connector_sync_cursors (install_id, stream, cursor, last_synced_at)
      VALUES (${installId}, 'messages', 'cursor-before', ${new Date("2026-05-23T00:00:00.000Z")})
    `;
    syncHandler.mockResolvedValueOnce({
      stream: "messages",
      nextCursor: "cursor-after",
      items: [{
        stream: "messages",
        externalId: "msg-1",
        occurredAt: "2026-05-24T00:00:00.000Z",
        payload: { subject: "Hello" },
      }],
    });

    const result = await syncConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId,
      streams: ["messages"],
      actor: "owner-sync",
    });

    expect(result).toMatchObject({
      installId,
      connectorSlug: "sync-runner-test",
      success: true,
      itemCount: 1,
      results: [{
        stream: "messages",
        nextCursor: "cursor-after",
        items: [expect.objectContaining({ externalId: "msg-1" })],
      }],
    });
    expect(syncHandler).toHaveBeenCalledWith(expect.objectContaining({
      args: { stream: "messages", cursor: "cursor-before" },
    }));

    const [cursor] = await sql<{ cursor: string | null; last_error: string | null }[]>`
      SELECT cursor, last_error
      FROM connector_sync_cursors
      WHERE install_id = ${installId} AND stream = 'messages'
    `;
    expect(cursor.cursor).toBe("cursor-after");
    expect(cursor.last_error).toBeNull();
  });

  it("refuses installs outside the requested hive", async () => {
    const installId = await insertInstall({ hiveId: OTHER_HIVE_ID });

    await expect(syncConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId,
      streams: ["messages"],
    })).rejects.toMatchObject({
      status: 404,
      message: "connector install not found",
    });
  });

  it("refuses disabled or broken installs", async () => {
    const installId = await insertInstall({ status: "disabled" });

    await expect(syncConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId,
      streams: ["messages"],
    })).rejects.toMatchObject({
      status: 409,
      message: "connector install is disabled",
    });
    expect(syncHandler).not.toHaveBeenCalled();
  });

  it("refuses sync operations that are not safe read or system operations", async () => {
    const installId = await insertInstall({
      connectorSlug: "unsafe-sync-runner-test",
      grantedScopes: ["unsafe-sync-runner-test:test_connection", "unsafe-sync-runner-test:sync"],
    });

    await expect(syncConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId,
      streams: ["default"],
    })).rejects.toMatchObject({
      status: 400,
      message: "connector has no safe sync operation for stream default",
    });
  });

  it("marks the stream failed and returns a redacted error when invocation fails", async () => {
    const installId = await insertInstall();
    syncHandler.mockRejectedValueOnce(new Error("api token=secret-token failed"));

    const result = await syncConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId,
      streams: ["messages"],
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([{
      stream: "messages",
      error: "api token=[REDACTED] failed",
    }]);

    const [cursor] = await sql<{ cursor: string | null; last_error: string | null }[]>`
      SELECT cursor, last_error
      FROM connector_sync_cursors
      WHERE install_id = ${installId} AND stream = 'messages'
    `;
    expect(cursor.cursor).toBeNull();
    expect(cursor.last_error).toBe("api token=[REDACTED] failed");
  });

  it("imports normalized sync items through external record adapters and reports import counts", async () => {
    const installId = await insertInstall();
    syncHandler.mockResolvedValueOnce({
      stream: "invoices",
      nextCursor: "cursor-1",
      items: [{
        stream: "invoices",
        externalId: "invoice-1",
        occurredAt: "2026-05-24T00:00:00.000Z",
        payload: {
          family: "finance",
          kind: "invoice",
          title: "Invoice paid",
          amountCents: 12000,
          currency: "usd",
          counterparty: "Acme",
        },
      }],
    });

    const first = await syncConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId,
      streams: ["invoices"],
      actor: "owner-sync",
    });

    expect(first).toMatchObject({
      success: true,
      itemCount: 1,
      importedCount: 1,
      updatedCount: 0,
      rejectedCount: 0,
      importErrors: [],
    });

    syncHandler.mockResolvedValueOnce({
      stream: "invoices",
      nextCursor: "cursor-2",
      items: [{
        stream: "invoices",
        externalId: "invoice-1",
        payload: {
          family: "finance",
          kind: "invoice",
          title: "Invoice paid - updated",
          amountCents: 12500,
          currency: "usd",
          counterparty: "Acme",
        },
      }],
    });

    const second = await syncConnectorInstall(sql, {
      hiveId: HIVE_ID,
      installId,
      streams: ["invoices"],
      actor: "owner-sync",
    });

    expect(second).toMatchObject({
      success: true,
      itemCount: 1,
      importedCount: 0,
      updatedCount: 1,
      rejectedCount: 0,
    });

    const rows = await listRecentHiveRecords(sql, HIVE_ID, { limit: 10, hiveKind: "business" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectorInstallId: installId,
      sourceConnector: "sync-runner-test",
      externalId: "invoice-1",
      family: "finance",
      type: "sale",
      title: "Invoice paid - updated",
      amountCents: 12500,
    });
  });
});
