import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ConnectorSyncError: class ConnectorSyncError extends Error {
    status: number;

    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
  syncConnectorInstall: vi.fn(),
}));

vi.mock("../../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/connectors/sync", () => ({
  ConnectorSyncError: mocks.ConnectorSyncError,
  syncConnectorInstall: mocks.syncConnectorInstall,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "install-1" }) };

function syncRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/connector-installs/install-1/sync", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/connector-installs/[id]/sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sql.mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.syncConnectorInstall.mockResolvedValue({
      installId: "install-1",
      connectorSlug: "sync-runner-test",
      success: true,
      itemCount: 2,
      results: [
        { stream: "messages", nextCursor: "cursor-2", items: [{ externalId: "m1" }, { externalId: "m2" }] },
      ],
      errors: [],
    });
  });

  it("rejects unauthenticated callers before syncing", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await POST(syncRequest({ hiveId: "11111111-1111-4111-8111-111111111111" }), params);

    expect(res.status).toBe(401);
    expect(mocks.canMutateHive).not.toHaveBeenCalled();
    expect(mocks.syncConnectorInstall).not.toHaveBeenCalled();
  });

  it("requires hiveId before checking permissions", async () => {
    const res = await POST(syncRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.canMutateHive).not.toHaveBeenCalled();
    expect(mocks.syncConnectorInstall).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-members before syncing guessed install IDs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await POST(syncRequest({ hiveId: "11111111-1111-4111-8111-111111111111", streams: ["messages"] }), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot manage this hive");
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mocks.syncConnectorInstall).not.toHaveBeenCalled();
  });

  it("runs sync for hive members and returns counts without raw errors", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(true);

    const res = await POST(syncRequest({ hiveId: "11111111-1111-4111-8111-111111111111", streams: ["messages"] }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      installId: "install-1",
      success: true,
      itemCount: 2,
    });
    expect(mocks.syncConnectorInstall).toHaveBeenCalledWith(mocks.sql, {
      hiveId: "11111111-1111-4111-8111-111111111111",
      installId: "install-1",
      streams: ["messages"],
      actor: "member-1",
    });
  });

  it("defaults to the default stream when streams are omitted", async () => {
    const res = await POST(syncRequest({ hiveId: "11111111-1111-4111-8111-111111111111" }), params);

    expect(res.status).toBe(200);
    expect(mocks.syncConnectorInstall).toHaveBeenCalledWith(mocks.sql, expect.objectContaining({
      streams: ["default"],
    }));
  });

  it("rejects invalid stream lists", async () => {
    const res = await POST(syncRequest({ hiveId: "11111111-1111-4111-8111-111111111111", streams: ["messages", ""] }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("streams must be a non-empty array of strings");
    expect(mocks.syncConnectorInstall).not.toHaveBeenCalled();
  });

  it("maps sync runner errors to redacted API errors", async () => {
    const error = new mocks.ConnectorSyncError("install is disabled token=secret-token", 409);
    mocks.syncConnectorInstall.mockRejectedValueOnce(error);

    const res = await POST(syncRequest({ hiveId: "11111111-1111-4111-8111-111111111111", streams: ["messages"] }), params);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("install is disabled token=[REDACTED]");
  });
});
