import { afterEach, describe, expect, it, vi } from "vitest";
import { getConnectorDefinition } from "@/connectors/registry";

describe("Gmail governed research intake connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to readonly OAuth and exposes thread-detail research intake posture", () => {
    const gmail = getConnectorDefinition("gmail");

    expect(gmail?.oauth?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(gmail?.description).toMatch(/read-only gmail research intake/i);
    expect(gmail?.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "gmail:list_threads", required: true, kind: "read" }),
      expect.objectContaining({ key: "gmail:get_thread", required: true, kind: "read" }),
    ]));
    expect(gmail?.scopes.map((scope) => scope.key)).not.toEqual(expect.arrayContaining([
      "gmail:send_email",
      "gmail:label_thread",
    ]));
    expect(gmail?.operations.map((operation) => operation.slug)).not.toEqual(expect.arrayContaining([
      "send_email",
      "label_thread",
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

  it("preserves href/src URLs from HTML-only message bodies while returning sanitized text", async () => {
    const gmail = getConnectorDefinition("gmail");
    const getThread = gmail?.operations.find((operation) => operation.slug === "get_thread");
    expect(getThread).toBeDefined();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      id: "thread-html",
      historyId: "history-html",
      messages: [{
        id: "msg-html",
        threadId: "thread-html",
        snippet: "HTML report available",
        payload: {
          headers: [
            { name: "Subject", value: "HTML-only report" },
            { name: "From", value: "Reporter <reporter@example.com>" },
          ],
          parts: [{
            mimeType: "text/html",
            body: {
              data: Buffer.from(
                '<html><body><p>Read the <a href="https://example.com/report?utm=1&amp;ref=email">report</a>.</p><img src="https://cdn.example.com/chart.png" /></body></html>',
                "utf8",
              ).toString("base64url"),
            },
          }],
        },
      }],
    }), { status: 200 }));

    const result = await getThread!.handler({
      config: {},
      secrets: {},
      args: { _accessToken: "token", threadId: "thread-html", maxBodyChars: "500" },
    }) as Record<string, unknown>;

    expect(result.bodyText).toBe("Read the report .");
    expect(result.links).toEqual([
      "https://example.com/report?utm=1&ref=email",
      "https://cdn.example.com/chart.png",
    ]);
    expect(result.provenance).toMatchObject({
      linksExtractedOnly: true,
      linksFollowed: false,
    });
  });
});
