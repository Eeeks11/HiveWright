// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectorsPage from "../../src/app/(dashboard)/setup/connectors/page";

const hiveContextMock = vi.hoisted(() => ({
  value: {
    selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" } as
      | { id: string; slug: string; name: string; type: string }
      | null,
    hives: [
      { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      { id: "hive-2", slug: "hive-two", name: "Hive Two", type: "digital" },
    ],
    loading: false,
    hasProvider: true,
    selectHive: () => {},
  },
  searchParams: new URLSearchParams(),
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => hiveContextMock.value,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => hiveContextMock.searchParams,
  usePathname: () => "/setup/connectors",
}));

describe("ConnectorsPage", () => {
  beforeEach(() => {
    hiveContextMock.value.selected = { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" };
    hiveContextMock.value.hives = [
      { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      { id: "hive-2", slug: "hive-two", name: "Hive Two", type: "digital" },
    ];
    hiveContextMock.value.hasProvider = true;
    hiveContextMock.value.loading = false;
    hiveContextMock.searchParams = new URLSearchParams();
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
      if (url === "/api/connector-installs/install-1/actions?hiveId=hive-1") {
        return jsonResponse({ data: [actionFixture()] });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/connector-installs/install-1/actions?hiveId=hive-1"));

    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText(/last tested/i)).toBeTruthy();
    expect(screen.getAllByText("send").length).toBeGreaterThan(0);
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("notify") ?? false).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("require_approval") ?? false).length).toBeGreaterThan(0);
    expect(screen.getByText("discord-webhook:send_message")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Action policies" }).getAttribute("href")).toBe("/setup/action-policies");
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("send_message · succeeded") ?? false).length).toBeGreaterThan(0);
  });

  it("passes the explicit hive target to connector install resource actions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") return jsonResponse({ data: [connectorFixture()] });
      if (url === "/api/connector-installs?hiveId=hive-1") return jsonResponse({ data: [installFixture()] });
      if (url === "/api/connector-installs/install-1/actions?hiveId=hive-1") return jsonResponse({ data: [] });
      if (url === "/api/connector-installs/install-1/test" && init?.method === "POST") {
        return jsonResponse({ data: { success: true, durationMs: 5 } });
      }
      if (url === "/api/connector-installs/install-1" && init?.method === "PATCH") {
        return jsonResponse({ data: { ...installFixture(), status: "disabled" } });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ConnectorsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Test Discord" }));
    await waitFor(() => {
      const testCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/connector-installs/install-1/test" && init?.method === "POST",
      );
      expect(testCall).toBeTruthy();
      expect(JSON.parse(testCall![1]!.body as string).hiveId).toBe("hive-1");
    });

    fireEvent.click(await screen.findByRole("button", { name: "Disable Discord" }));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/connector-installs/install-1" && init?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(patchCall![1]!.body as string)).toMatchObject({
        hiveId: "hive-1",
        status: "disabled",
      });
    });
  });

  it("loads and persists shared EA primary and fallback routing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") return jsonResponse({ data: [] });
      if (url === "/api/connector-installs?hiveId=hive-1") return jsonResponse({ data: [] });
      if (url === "/api/hives/hive-1" && !init?.method) {
        return jsonResponse({
          data: {
            eaModelConfiguration: {
              primaryModel: "openai-codex/gpt-5.6-sol",
              fallbackModel: "openai-codex/gpt-5.5",
            },
          },
        });
      }
      if (url === "/api/hives/hive-1" && init?.method === "PATCH") {
        return jsonResponse({
          data: { eaModelConfiguration: JSON.parse(init.body as string).eaModelConfiguration },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    const primary = await screen.findByLabelText("EA primary model");
    const fallback = screen.getByLabelText("EA fallback model");
    expect((primary as HTMLInputElement).value).toBe("openai-codex/gpt-5.6-sol");
    expect((fallback as HTMLInputElement).value).toBe("openai-codex/gpt-5.5");

    fireEvent.change(fallback, { target: { value: "openai-codex/gpt-5.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save EA routing" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/hives/hive-1" && init?.method === "PATCH",
      );
      expect(JSON.parse(patchCall![1]!.body as string)).toEqual({
        eaModelConfiguration: {
          primaryModel: "openai-codex/gpt-5.6-sol",
          fallbackModel: "openai-codex/gpt-5.4",
        },
      });
    });
  });

  it("preserves targetHiveId when linking from the setup connectors mirror", async () => {
    hiveContextMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") return jsonResponse({ data: [] });
      if (url === "/api/connector-installs?hiveId=hive-2") return jsonResponse({ data: [] });
      return new Response("not found", { status: 404 });
    }));

    render(<ConnectorsPage />);

    expect((await screen.findByRole("link", { name: "Action policies" })).getAttribute("href")).toBe(
      "/setup/action-policies?targetHiveId=hive-2",
    );
  });

  it("uses targetHiveId for connector install reads and destination-confirmed installs", async () => {
    hiveContextMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") return jsonResponse({ data: [connectorFixture()] });
      if (url === "/api/connector-installs?hiveId=hive-2") return jsonResponse({ data: [] });
      if (url === "/api/connector-installs" && init?.method === "POST") return jsonResponse({ data: { id: "install-2" } });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<ConnectorsPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/connector-installs?hiveId=hive-2"));
    expect(screen.getByText(/Target mode: viewing/)).toBeTruthy();
    fireEvent.click(await screen.findByText("Discord webhook"));
    fireEvent.click(screen.getByRole("button", { name: "Save & test" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/connector-installs" && init?.method === "POST");
      expect(postCall).toBeTruthy();
      expect(JSON.parse(postCall![1]!.body as string).hiveId).toBe("hive-2");
    });
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("will update Hive Two, not your active hive Hive One"));
  });

  it("fails closed for invalid targetHiveId without loading active-hive connector installs", () => {
    hiveContextMock.searchParams = new URLSearchParams("targetHiveId=missing-hive");
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(screen.getByText(/Hive target/).textContent).toContain("missing-hive");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/connector-installs?hiveId=hive-1");
  });

  it("continues resolving when a stale non-empty hive list does not contain the requested connector target", () => {
    hiveContextMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    hiveContextMock.value.hives = [{ id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" }];
    hiveContextMock.value.loading = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(screen.getByText("Resolving hive target...")).toBeTruthy();
    expect(screen.queryByText(/Hive target/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function connectorFixture() {
  return {
    slug: "discord-webhook",
    name: "Discord webhook",
    category: "messaging",
    description: "Post messages to Discord",
    icon: null,
    authType: "webhook",
    setupFields: [],
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
