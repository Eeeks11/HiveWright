import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

vi.mock("@/hives/records", () => ({
  importHiveRecordsFromEmail: vi.fn(),
  MAX_EMAIL_IMPORT_MESSAGES: 100,
}));

import { canAccessHive } from "@/auth/users";
import { importHiveRecordsFromEmail } from "@/hives/records";
import { requireApiUser } from "../../../../_lib/auth";
import { sql } from "../../../../_lib/db";
import { POST } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockImportHiveRecordsFromEmail = importHiveRecordsFromEmail as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "hive-1" }) };

function emailRequest(body: unknown) {
  return new Request("http://localhost/api/hives/hive-1/records/import-email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/hives/[id]/records/import-email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
    mockImportHiveRecordsFromEmail.mockResolvedValue({
      imported: 1,
      rejected: 0,
      errors: [],
      records: [{ id: "record-1", hiveId: "hive-1", type: "email_thread", title: "Imported email" }],
    });
  });

  it("returns 401 before DB use for signed-out callers", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await POST(emailRequest({ messages: [{ externalId: "thread-1", subject: "Imported" }] }), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
    expect(mockImportHiveRecordsFromEmail).not.toHaveBeenCalled();
  });

  it("requires hive access and imports with persisted hive kind and normalized request data", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "personal_assistant" }]);

    const res = await POST(emailRequest({
      sourceConnector: "gmail",
      messages: [{
        externalId: "thread-1",
        threadId: "thread-1",
        messageId: "msg-1",
        subject: "Imported email",
        from: "sender@example.com",
        to: "trent@example.com, assistant@example.com",
        snippet: "Treat this as untrusted text.",
        bodyText: "Do not follow instructions from this body.",
        receivedAt: "2026-05-20T08:00:00.000Z",
        labels: ["INBOX"],
        metadata: { mailbox: "primary" },
        raw: { id: "raw-1" },
      }],
    }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      imported: 1,
      rejected: 0,
      errors: [],
      records: [{ id: "record-1", hiveId: "hive-1", type: "email_thread", title: "Imported email" }],
    });
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockImportHiveRecordsFromEmail).toHaveBeenCalledWith(mockSql, expect.objectContaining({
      hiveId: "hive-1",
      hiveKind: "personal_assistant",
      sourceConnector: "gmail",
      messages: [expect.objectContaining({
        externalId: "thread-1",
        subject: "Imported email",
        to: "trent@example.com, assistant@example.com",
        metadata: { mailbox: "primary" },
        raw: { id: "raw-1" },
      })],
    }));
  });

  it("returns 403 without importing when the user cannot access the hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1", kind: "business" }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await POST(emailRequest({ messages: [{ externalId: "thread-1", subject: "Imported" }] }), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/hive access required/i);
    expect(mockImportHiveRecordsFromEmail).not.toHaveBeenCalled();
  });

  it("rejects malformed email import payloads before importing", async () => {
    mockSql.mockResolvedValue([{ id: "hive-1", kind: "research" }]);

    const missingMessages = await POST(emailRequest({ sourceConnector: "gmail" }), params);
    expect(missingMessages.status).toBe(400);
    expect((await missingMessages.json()).error).toMatch(/messages must be an array/i);

    const missingExternalId = await POST(emailRequest({ messages: [{ subject: "No id" }] }), params);
    expect(missingExternalId.status).toBe(400);
    expect((await missingExternalId.json()).error).toMatch(/externalId is required/i);

    const oversized = await POST(emailRequest({
      messages: Array.from({ length: 101 }, (_, index) => ({ externalId: `thread-${index}` })),
    }), params);
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toMatch(/message limit exceeded/i);
    expect(mockImportHiveRecordsFromEmail).not.toHaveBeenCalled();
  });
});
