import { beforeEach, describe, expect, it } from "vitest";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";
import {
  createWebhookIngressToken,
  ingestConnectorWebhook,
} from "@/connectors/webhook-ingress";
import { listRecentHiveRecords } from "@/hives/records";

async function insertHive(kind: string, label: string): Promise<string> {
  const ns = createFixtureNamespace(`webhook-ingress-${label}`);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type, kind)
    VALUES (${ns.slug(label)}, ${`${label} Hive`}, 'digital', ${kind})
    RETURNING id
  `;
  return row.id;
}

async function insertInstall(input: {
  hiveId: string;
  connectorSlug?: string;
  displayName?: string;
  status?: string;
}): Promise<string> {
  const connectorSlug = input.connectorSlug ?? "generic-webhook";
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO connector_installs (
      hive_id, connector_slug, display_name, config, granted_scopes, status
    )
    VALUES (
      ${input.hiveId}::uuid,
      ${connectorSlug},
      ${input.displayName ?? "Generic Webhook"},
      ${sql.json({})},
      ${sql.json([`${connectorSlug}:test_connection`])},
      ${input.status ?? "active"}
    )
    RETURNING id
  `;
  return row.id;
}

beforeEach(async () => {
  await truncateAll(sql);
});

describe("webhook ingress tokens", () => {
  it("stores only a token hash scoped to one install and stream", async () => {
    const hiveId = await insertHive("business", "token");
    const installId = await insertInstall({ hiveId });

    const issued = await createWebhookIngressToken(sql, {
      installId,
      stream: "leads",
      label: "CRM leads",
    });

    expect(issued.token).toMatch(/^hwwh_/);
    expect(issued.stream).toBe("leads");

    const [row] = await sql<{
      install_id: string;
      stream: string;
      label: string | null;
      token_hash: string;
    }[]>`
      SELECT install_id, stream, label, token_hash
      FROM connector_webhook_tokens
      WHERE id = ${issued.id}
    `;

    expect(row).toMatchObject({
      install_id: installId,
      stream: "leads",
      label: "CRM leads",
    });
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).not.toContain(issued.token);
    expect(JSON.stringify(row)).not.toContain(issued.token);
  });

  it("rejects disabled installs before importing webhook records", async () => {
    const hiveId = await insertHive("business", "disabled");
    const installId = await insertInstall({ hiveId, status: "disabled" });
    const { token } = await createWebhookIngressToken(sql, { installId });

    await expect(ingestConnectorWebhook(sql, {
      installId,
      token,
      externalId: "evt-1",
      family: "crm",
      payload: { kind: "lead", title: "Lead" },
    })).rejects.toMatchObject({
      status: 409,
      message: "connector install is disabled",
    });

    const rows = await listRecentHiveRecords(sql, hiveId, { hiveKind: "business" });
    expect(rows).toHaveLength(0);
  });
});

describe("webhook ingress imports", () => {
  it("authenticates the token, resolves hive from the install, and imports untrusted redacted records", async () => {
    const hiveId = await insertHive("business", "import");
    const installId = await insertInstall({ hiveId, connectorSlug: "crm-webhook" });
    const { token } = await createWebhookIngressToken(sql, { installId, stream: "leads" });

    const result = await ingestConnectorWebhook(sql, {
      installId,
      token,
      stream: "leads",
      externalId: "lead-1",
      family: "crm",
      payload: {
        kind: "lead",
        title: "New lead",
        counterparty: "Acme",
        accessToken: "secret-token",
      },
    });

    expect(result).toMatchObject({
      installId,
      connectorSlug: "crm-webhook",
      stream: "leads",
      imported: 1,
      updated: 0,
      rejected: 0,
    });
    expect(result.records[0]).toMatchObject({
      hiveId,
      connectorInstallId: installId,
      sourceConnector: "crm-webhook",
      externalId: "lead-1",
      family: "relationship",
      type: "customer_event",
      title: "New lead",
      metadata: expect.objectContaining({ untrusted: true }),
      normalized: expect.objectContaining({ untrustedInput: true }),
      rawRedacted: expect.objectContaining({ accessToken: "[REDACTED]" }),
    });

    const [event] = await sql<{ operation: string; status: string; actor: string | null }[]>`
      SELECT operation, status, actor
      FROM connector_events
      WHERE install_id = ${installId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(event).toEqual({
      operation: "webhook_ingest",
      status: "success",
      actor: "webhook",
    });
  });

  it("rejects wrong tokens and stream mismatches", async () => {
    const hiveId = await insertHive("business", "wrong-token");
    const installId = await insertInstall({ hiveId });
    const { token } = await createWebhookIngressToken(sql, { installId, stream: "default" });

    await expect(ingestConnectorWebhook(sql, {
      installId,
      token: "hwwh_wrong",
      externalId: "evt-1",
      family: "webhook",
      payload: { title: "Wrong token" },
    })).rejects.toMatchObject({
      status: 401,
      message: "invalid webhook token",
    });

    await expect(ingestConnectorWebhook(sql, {
      installId,
      token,
      stream: "other",
      externalId: "evt-1",
      family: "webhook",
      payload: { title: "Wrong stream" },
    })).rejects.toMatchObject({
      status: 403,
      message: "webhook token is not valid for stream other",
    });
  });

  it("upserts repeated webhook events but keeps different installs isolated", async () => {
    const hiveId = await insertHive("business", "dedupe");
    const firstInstallId = await insertInstall({ hiveId, connectorSlug: "crm-webhook", displayName: "CRM A" });
    const secondInstallId = await insertInstall({ hiveId, connectorSlug: "crm-webhook", displayName: "CRM B" });
    const firstToken = await createWebhookIngressToken(sql, { installId: firstInstallId });
    const secondToken = await createWebhookIngressToken(sql, { installId: secondInstallId });

    await ingestConnectorWebhook(sql, {
      installId: firstInstallId,
      token: firstToken.token,
      externalId: "lead-1",
      family: "crm",
      payload: { kind: "lead", title: "Original lead" },
    });

    const updated = await ingestConnectorWebhook(sql, {
      installId: firstInstallId,
      token: firstToken.token,
      externalId: "lead-1",
      family: "crm",
      payload: { kind: "lead", title: "Updated lead" },
    });

    const separate = await ingestConnectorWebhook(sql, {
      installId: secondInstallId,
      token: secondToken.token,
      externalId: "lead-1",
      family: "crm",
      payload: { kind: "lead", title: "Other install lead" },
    });

    expect(updated).toMatchObject({ imported: 0, updated: 1, rejected: 0 });
    expect(separate).toMatchObject({ imported: 1, updated: 0, rejected: 0 });

    const rows = await listRecentHiveRecords(sql, hiveId, { limit: 10, hiveKind: "business" });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.connectorInstallId).sort()).toEqual([
      firstInstallId,
      secondInstallId,
    ].sort());
    expect(rows.map((row) => row.title).sort()).toEqual([
      "Other install lead",
      "Updated lead",
    ].sort());
  });
});
