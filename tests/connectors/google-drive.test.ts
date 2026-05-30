import { describe, expect, it, vi, afterEach } from "vitest";
import { CONNECTOR_REGISTRY } from "@/connectors/registry";

const googleDrive = CONNECTOR_REGISTRY.find((connector) => connector.slug === "google-drive");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google Drive connector", () => {
  it("is registered as a Google OAuth connector with metadata and file-read operations", () => {
    expect(googleDrive).toBeTruthy();
    expect(googleDrive?.authType).toBe("oauth2");
    expect(googleDrive?.oauth?.clientIdEnv).toBe("GOOGLE_DRIVE_CLIENT_ID");
    expect(googleDrive?.oauth?.scopes).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ]));
    expect(googleDrive?.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "google-drive:metadata.read", kind: "read" }),
      expect.objectContaining({ key: "google-drive:file.read", kind: "pii", required: false }),
    ]));
    expect(googleDrive?.operations.map((operation) => operation.slug)).toEqual(expect.arrayContaining([
      "test_connection",
      "list_files",
      "get_file_metadata",
      "read_file_text",
    ]));
  });

  it("lists Drive files using the injected OAuth access token without side effects", async () => {
    const operation = googleDrive?.operations.find((op) => op.slug === "list_files");
    expect(operation?.governance.externalSideEffect).toBe(false);
    expect(operation?.governance.defaultDecision).toBe("allow");

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("https://www.googleapis.com/drive/v3/files");
      expect(url).toContain("pageSize=5");
      expect(url).toContain("supportsAllDrives=true");
      expect(init?.headers).toEqual({ Authorization: "Bearer access-123" });
      return new Response(JSON.stringify({ files: [{ id: "file-1", name: "Ops Plan" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const result = await operation!.handler({
      config: {},
      secrets: {},
      args: { _accessToken: "access-123", query: "name contains 'Ops'", maxResults: "5" },
    });

    expect(result).toEqual({ files: [{ id: "file-1", name: "Ops Plan" }] });
  });

  it("exports Google Docs content as text with approval-required governance", async () => {
    const operation = googleDrive?.operations.find((op) => op.slug === "read_file_text");
    expect(operation?.governance.defaultDecision).toBe("require_approval");
    expect(operation?.governance.riskTier).toBe("medium");
    expect(operation?.governance.externalSideEffect).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/drive/v3/files/doc-1/export");
      expect(url).toContain("mimeType=text%2Fplain");
      expect(init?.headers).toEqual({ Authorization: "Bearer access-123" });
      return new Response("hello from docs", { status: 200 });
    }));

    const result = await operation!.handler({
      config: {},
      secrets: {},
      args: {
        _accessToken: "access-123",
        fileId: "doc-1",
        mimeType: "application/vnd.google-apps.document",
      },
    });

    expect(result).toEqual({
      fileId: "doc-1",
      mimeType: "application/vnd.google-apps.document",
      truncated: false,
      text: "hello from docs",
    });
  });

  it("caps Drive file text reads by bytes and cancels oversized streams", async () => {
    const operation = googleDrive?.operations.find((op) => op.slug === "read_file_text");
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("abcdefghij"));
      },
      cancel() {
        cancelled = true;
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const result = await operation!.handler({
      config: {},
      secrets: {},
      args: {
        _accessToken: "access-123",
        fileId: "text-1",
        mimeType: "text/plain",
        maxBytes: "12",
      },
    });

    expect(result).toEqual({
      fileId: "text-1",
      mimeType: "text/plain",
      truncated: true,
      text: "abcdefghijab",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

});
