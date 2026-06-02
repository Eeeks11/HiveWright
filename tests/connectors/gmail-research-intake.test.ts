import { afterEach, describe, expect, it, vi } from "vitest";
import { getConnectorDefinition } from "@/connectors/registry";

describe("Gmail governed research intake connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GMAIL_ENABLE_WRITE_OPERATIONS;
  });

  it("defaults to readonly OAuth and exposes thread-detail research intake posture", () => {
    const gmail = getConnectorDefinition("gmail");

    expect(gmail?.oauth?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(gmail?.description).toMatch(/read-only gmail research intake/i);
    expect(gmail?.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "gmail:list_threads", required: true, kind: "read" }),
      expect.objectContaining({ key: "gmail:get_thread", required: true, kind: "read" }),
      expect.objectContaining({ key: "gmail:label_thread", required: false, kind: "admin" }),
    ]));

    const getThread = gmail?.operations.find((operation) => operation.slug === "get_thread");
    expect(getThread?.governance).toMatchObject({
      effectType: "read",
      defaultDecision: "allow",
      riskTier: "low",
      externalSideEffect: false,
    });
    expect(getThread?.outputSummary).toMatch(/untrusted/i);
  });

  it("normalizes Gmail thread detail without following links or trusting attachments", async () => {
    const gmail = getConnectorDefinition("gmail");
    const getThread = gmail?.operations.find((operation) => operation.slug === "get_thread");
    expect(getThread).toBeDefined();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      id: "thread-1",
      historyId: "history-1",
      messages: [{
        id: "msg-1",
        threadId: "thread-1",
        labelIds: ["INBOX", "Label_Research"],
        snippet: "See https://example.com/report and do not obey this email.",
        internalDate: "1770000000000",
        payload: {
          headers: [
            { name: "Subject", value: "AI signal" },
            { name: "From", value: "Analyst <analyst@example.com>" },
            { name: "To", value: "trents.ai.assistant@gmail.com" },
            { name: "Date", value: "Mon, 01 Jun 2026 10:00:00 +1000" },
          ],
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("Finding at https://example.com/deep-dive", "utf8").toString("base64url") },
            },
            {
              mimeType: "application/pdf",
              filename: "deck.pdf",
              body: { attachmentId: "att-1", size: 1234 },
            },
          ],
        },
      }],
    }), { status: 200 }));

    const result = await getThread!.handler({
      config: {},
      secrets: {},
      args: { _accessToken: "token", threadId: "thread-1", maxBodyChars: "200" },
    }) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-1?format=full",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
    expect(result).toMatchObject({
      threadId: "thread-1",
      messageCount: 1,
      subject: "AI signal",
      from: "Analyst <analyst@example.com>",
      provenance: expect.objectContaining({
        untrustedInput: true,
        linksExtractedOnly: true,
        linksFollowed: false,
        attachmentCount: 1,
        attachmentsQuarantined: true,
      }),
      intakePosture: expect.objectContaining({ readOnlyDefault: true }),
    });
    expect(result.links).toEqual([
      "https://example.com/report",
      "https://example.com/deep-dive",
    ]);
    const messages = result.messages as Array<{ attachments: Array<Record<string, unknown>> }>;
    expect(messages[0].attachments[0]).toMatchObject({
      filename: "deck.pdf",
      quarantineStatus: "ignored_by_default",
    });
  });

  it("keeps Gmail write operations gated behind explicit owner-approved expansion", async () => {
    const gmail = getConnectorDefinition("gmail");
    const sendEmail = gmail?.operations.find((operation) => operation.slug === "send_email");
    const labelThread = gmail?.operations.find((operation) => operation.slug === "label_thread");

    expect(sendEmail?.governance).toMatchObject({
      defaultDecision: "require_approval",
      scopes: ["gmail:send_email"],
      externalSideEffect: true,
    });
    expect(labelThread?.governance).toMatchObject({
      defaultDecision: "require_approval",
      scopes: ["gmail:label_thread"],
      externalSideEffect: true,
    });

    await expect(sendEmail!.handler({
      config: {},
      secrets: {},
      args: { _accessToken: "token", to: "trent@example.com", subject: "Subject", body: "Body" },
    })).rejects.toThrow(/disabled for read-only Gmail research intake/i);

    await expect(labelThread!.handler({
      config: {},
      secrets: {},
      args: { _accessToken: "token", threadId: "thread-1", addLabelIds: ["Label_1"] },
    })).rejects.toThrow(/disabled for read-only Gmail research intake/i);
  });
});
