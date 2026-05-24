import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ConnectorWebhookIngressError: class ConnectorWebhookIngressError extends Error {
    status: number;

    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
  sql: vi.fn(),
  ingestConnectorWebhook: vi.fn(),
}));

vi.mock("../../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/connectors/webhook-ingress", () => ({
  ConnectorWebhookIngressError: mocks.ConnectorWebhookIngressError,
  ingestConnectorWebhook: mocks.ingestConnectorWebhook,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ installId: "install-1" }) };

function webhookRequest(body: Record<string, unknown>, token = "hwwh_test-token") {
  return new Request("http://localhost/api/connectors/webhook/install-1", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

describe("POST /api/connectors/webhook/[installId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ingestConnectorWebhook.mockResolvedValue({
      installId: "install-1",
      connectorSlug: "crm-webhook",
      stream: "default",
      imported: 1,
      updated: 0,
      rejected: 0,
      errors: [],
      records: [{ id: "record-1", title: "New lead" }],
    });
  });

  it("rejects requests without a bearer token before ingestion", async () => {
    const res = await POST(webhookRequest({
      externalId: "evt-1",
      family: "crm",
      payload: { title: "Lead" },
    }, ""), params);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("missing webhook bearer token");
    expect(mocks.ingestConnectorWebhook).not.toHaveBeenCalled();
  });

  it("rejects missing externalId before ingestion", async () => {
    const res = await POST(webhookRequest({
      family: "crm",
      payload: { title: "Lead" },
    }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("externalId is required");
    expect(mocks.ingestConnectorWebhook).not.toHaveBeenCalled();
  });

  it("rejects non-object payloads before ingestion", async () => {
    const res = await POST(webhookRequest({
      externalId: "evt-1",
      family: "crm",
      payload: "not-json-object",
    }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("payload must be an object");
    expect(mocks.ingestConnectorWebhook).not.toHaveBeenCalled();
  });

  it("passes install id, token, stream, external id, family, and payload to ingress helper", async () => {
    const res = await POST(webhookRequest({
      stream: "leads",
      externalId: "lead-1",
      family: "crm",
      occurredAt: "2026-05-24T00:00:00.000Z",
      payload: { kind: "lead", title: "New lead" },
    }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      installId: "install-1",
      imported: 1,
      records: [{ id: "record-1", title: "New lead" }],
    });
    expect(mocks.ingestConnectorWebhook).toHaveBeenCalledWith(mocks.sql, {
      installId: "install-1",
      token: "hwwh_test-token",
      stream: "leads",
      externalId: "lead-1",
      family: "crm",
      occurredAt: "2026-05-24T00:00:00.000Z",
      payload: { kind: "lead", title: "New lead" },
    });
  });

  it("maps ingress errors to redacted API errors", async () => {
    mocks.ingestConnectorWebhook.mockRejectedValueOnce(
      new mocks.ConnectorWebhookIngressError("invalid token=secret-token", 401),
    );

    const res = await POST(webhookRequest({
      externalId: "evt-1",
      family: "webhook",
      payload: { title: "Event" },
    }), params);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("invalid token=[REDACTED]");
  });
});
