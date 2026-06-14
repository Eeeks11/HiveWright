// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectorsPage from "../../src/app/(dashboard)/setup/connectors/page";

const hiveContextMock = vi.hoisted(() => ({
  value: {
    selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" } as
      | { id: string; slug: string; name: string; type: string }
      | null,
    hives: [] as Array<{ id: string; slug: string; name: string; type: string }>,
    loading: false,
    selectHive: () => {},
    hasProvider: true,
  },
}));

const navigationMock = vi.hoisted(() => ({
  pathname: "/settings/connectors",
  searchParams: new URLSearchParams(),
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => hiveContextMock.value,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useSearchParams: () => navigationMock.searchParams,
}));

describe("ConnectorsPage", () => {
  beforeEach(() => {
    navigationMock.pathname = "/settings/connectors";
    navigationMock.searchParams = new URLSearchParams();
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [],
      loading: false,
      selectHive: () => {},
    hasProvider: true,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows installed health, capability risk, scopes, policy link, and recent actions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") {
        return jsonResponse({ data: [connectorFixture()] });
      }
      if (url === "/api/connector-installs?hiveId=hive-1") {
        return jsonResponse({ data: [installFixture()] });
      }
      if (url === "/api/connector-installs/install-1/actions") {
        return jsonResponse({ data: [actionFixture()] });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/connector-installs/install-1/actions"));

    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText(/last tested/i)).toBeTruthy();
    expect(screen.getAllByText("send").length).toBeGreaterThan(0);
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("notify") ?? false).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("require_approval") ?? false).length).toBeGreaterThan(0);
    expect(screen.getByText("discord-webhook:send_message")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Action policies" }).getAttribute("href")).toBe("/setup/action-policies");
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("send_message · succeeded") ?? false).length).toBeGreaterThan(0);
  });

  it("loads installs for the query-backed target hive and preserves target mode through OAuth", async () => {
    navigationMock.searchParams = new URLSearchParams("targetHiveId=hive-2&oauth_installed=1");
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [
        { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
        { id: "hive-2", slug: "hive-two", name: "Hive Two", type: "digital" },
      ],
      loading: false,
      selectHive: () => {},
    hasProvider: true,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") return jsonResponse({ data: [oauthConnectorFixture()] });
      if (url === "/api/connector-installs?hiveId=hive-2") return jsonResponse({ data: [] });
      return new Response("not found", { status: 404 });
    });
    const promptMock = vi.fn(() => "not the target hive");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("prompt", promptMock);

    render(<ConnectorsPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/connector-installs?hiveId=hive-2"));
    expect(screen.getByText(/Target mode: viewing/)).toBeTruthy();
    const link = await screen.findByRole("link", { name: /Google Drive/ });
    expect(link.getAttribute("href")).toBe(
      "/api/oauth/google-drive/start?hiveId=hive-2&displayName=Google+Drive&redirectTo=%2Fsettings%2Fconnectors%3FtargetHiveId%3Dhive-2",
    );
    fireEvent.click(link);
    expect(promptMock).toHaveBeenCalledWith(expect.stringContaining("Start OAuth for Google Drive"));
  });

  it("fails closed for an unresolved connector target without calling connector APIs", () => {
    navigationMock.searchParams = new URLSearchParams("targetHiveId=missing-hive");
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [{ id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" }],
      loading: false,
      selectHive: () => {},
    hasProvider: true,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(screen.getByText(/Hive target/)).toBeTruthy();
    expect(screen.getByText("missing-hive")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for target hive resolution before calling connector APIs", () => {
    navigationMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [],
      loading: true,
      selectHive: () => {},
      hasProvider: true,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(screen.getByText("Resolving hive target...")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues resolving when a stale non-empty hive list does not contain the requested connector target", () => {
    navigationMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [{ id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" }],
      loading: true,
      selectHive: () => {},
      hasProvider: true,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(screen.getByText("Resolving hive target...")).toBeTruthy();
    expect(screen.queryByText(/Hive target/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires destination-named confirmation before cross-hive connector writes", async () => {
    navigationMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [
        { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
        { id: "hive-2", slug: "hive-two", name: "Hive Two", type: "digital" },
      ],
      loading: false,
      selectHive: () => {},
    hasProvider: true,
    };
    const promptMock = vi.fn(() => "wrong hive");
    vi.stubGlobal("prompt", promptMock);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") return jsonResponse({ data: [connectorFixture({ authType: "webhook", setupFields: [] })] });
      if (url === "/api/connector-installs?hiveId=hive-2") return jsonResponse({ data: [] });
      if (url === "/api/connector-installs" && init?.method === "POST") return jsonResponse({ data: { id: "new-install", connectorSlug: "discord-webhook" } }, 201);
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    fireEvent.click(await screen.findByText("Discord webhook"));
    fireEvent.click(screen.getByRole("button", { name: "Save & test" }));

    await waitFor(() => expect(promptMock).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/connector-installs", expect.anything());

    promptMock.mockReturnValueOnce("Hive Two");
    fireEvent.click(screen.getByRole("button", { name: "Save & test" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/connector-installs",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"hiveId":"hive-2"'),
      }),
    ));
  });
});

function connectorFixture(overrides: Partial<ReturnType<typeof baseConnectorFixture>> = {}) {
  return { ...baseConnectorFixture(), ...overrides };
}

function baseConnectorFixture() {
  return {
    slug: "discord-webhook",
    name: "Discord webhook",
    category: "messaging",
    description: "Post messages to Discord",
    icon: null,
    authType: "webhook" as const,
    setupFields: [] as SetupField[],
    scopes: [
      { key: "discord-webhook:test_connection", label: "Test connection", kind: "read", required: true },
      { key: "discord-webhook:send_message", label: "Send message", kind: "send", required: false },
    ],
    operations: [
      {
        slug: "send_message",
        label: "Send message",
        governance: { effectType: "notify", defaultDecision: "require_approval", riskTier: "medium" },
        outputSummary: "Posts a message.",
      },
    ],
  };
}

function oauthConnectorFixture() {
  return {
    ...baseConnectorFixture(),
    slug: "google-drive",
    name: "Google Drive",
    authType: "oauth2" as const,
    operations: [],
    scopes: [],
  };
}

function installFixture() {
  return {
    id: "install-1",
    hiveId: "hive-1",
    connectorSlug: "discord-webhook",
    displayName: "Discord",
    config: {},
    credentialId: "cred-1",
    status: "active",
    lastTestedAt: "2026-05-12T01:00:00.000Z",
    lastError: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    successes7d: 3,
    errors7d: 1,
    grantedScopes: ["discord-webhook:test_connection", "discord-webhook:send_message"],
  };
}

function actionFixture() {
  return {
    id: "action-1",
    connector: "discord-webhook",
    operation: "send_message",
    state: "succeeded",
    roleSlug: "ea",
    policyId: "policy-1",
    policyReason: "matched action policy policy-1",
    createdAt: "2026-05-12T02:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type SetupField = {
  key: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  type?: "text" | "url" | "password" | "textarea";
  required?: boolean;
};
