import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
    getConnectorDefinition: vi.fn(),
    resolveOAuthClient: vi.fn(),
    storeState: vi.fn(),
    buildAuthorizeUrl: vi.fn(),
    missingOAuthClientMessage: vi.fn(),
  };
});

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/connectors/registry", () => ({
  getConnectorDefinition: mocks.getConnectorDefinition,
}));

vi.mock("@/connectors/oauth", () => ({
  buildAuthorizeUrl: mocks.buildAuthorizeUrl,
  resolveOAuthClient: mocks.resolveOAuthClient,
  storeState: mocks.storeState,
  missingOAuthClientMessage: mocks.missingOAuthClientMessage,
}));

import { GET } from "@/app/api/oauth/[slug]/start/route";

const ctx = { params: Promise.resolve({ slug: "google-calendar" }) };
const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

function startRequest(hiveId = "hive-a"): Request {
  return new Request(
    `http://localhost/api/oauth/google-calendar/start?hiveId=${hiveId}&displayName=Calendar&redirectTo=/setup/connectors`,
  );
}

describe("GET /api/oauth/:slug/start authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_BASE_URL;
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.getConnectorDefinition.mockReturnValue({
      slug: "google-calendar",
      name: "Google Calendar",
      oauth: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        authorizeUrl: "https://provider.local/auth",
        tokenUrl: "https://provider.local/token",
        scopes: ["calendar.readonly"],
      },
    });
    mocks.resolveOAuthClient.mockReturnValue({
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    mocks.storeState.mockResolvedValue("state-1");
    mocks.buildAuthorizeUrl.mockReturnValue("https://provider.local/auth?state=state-1");
    mocks.missingOAuthClientMessage.mockReturnValue(
      "google-calendar OAuth is not ready yet. The HiveWright platform OAuth client is missing (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET). An owner must configure the platform OAuth app before hive users can connect their account.",
    );
  });

  afterEach(() => {
    if (originalPublicBaseUrl === undefined) {
      delete process.env.PUBLIC_BASE_URL;
    } else {
      process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
    }
  });

  it("refuses unauthorized hive state creation", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(startRequest("hive-other"), ctx);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-other");
    expect(mocks.storeState).not.toHaveBeenCalled();
    expect(mocks.buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it("creates OAuth state for authorized hive callers", async () => {
    const res = await GET(startRequest("hive-a"), ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://provider.local/auth?state=state-1");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.storeState).toHaveBeenCalledWith(mocks.sql, {
      hiveId: "hive-a",
      connectorSlug: "google-calendar",
      displayName: "Calendar",
      redirectTo: "/setup/connectors",
    });
  });

  it("returns API-safe setup status when the platform OAuth client is missing", async () => {
    mocks.resolveOAuthClient.mockReturnValueOnce(null);

    const res = await GET(startRequest("hive-a"), ctx);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe("oauth_client_not_configured");
    expect(body.error).toContain("platform OAuth client is missing");
    expect(mocks.storeState).not.toHaveBeenCalled();
  });

  it("redirects browser users back to connectors instead of leaving them on a JSON error page", async () => {
    mocks.resolveOAuthClient.mockReturnValueOnce(null);
    const req = new Request(
      "http://localhost/api/oauth/google-calendar/start?hiveId=hive-a&displayName=Calendar&redirectTo=/setup/connectors",
      { headers: { accept: "text/html" } },
    );

    const res = await GET(req, ctx);
    const location = new URL(res.headers.get("location") ?? "");

    expect(res.status).toBe(302);
    expect(location.pathname).toBe("/setup/connectors");
    expect(location.searchParams.get("oauth_setup_required")).toBe("google-calendar");
    expect(location.searchParams.get("oauth_error")).toContain("platform OAuth client is missing");
    expect(mocks.storeState).not.toHaveBeenCalled();
  });

  it("uses PUBLIC_BASE_URL for browser setup-error redirects behind a proxy", async () => {
    process.env.PUBLIC_BASE_URL = "https://hivewright.tailnet.example";
    mocks.resolveOAuthClient.mockReturnValueOnce(null);
    const req = new Request(
      "http://127.0.0.1:3002/api/oauth/google-calendar/start?hiveId=hive-a&displayName=Calendar&redirectTo=/setup/connectors",
      { headers: { accept: "text/html" } },
    );

    const res = await GET(req, ctx);
    const location = new URL(res.headers.get("location") ?? "");

    expect(res.status).toBe(302);
    expect(location.origin).toBe("https://hivewright.tailnet.example");
    expect(location.pathname).toBe("/setup/connectors");
    expect(location.searchParams.get("oauth_setup_required")).toBe("google-calendar");
  });

});
