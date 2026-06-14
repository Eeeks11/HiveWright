// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupHealthPage from "../../src/app/(dashboard)/setup/health/page";

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
  pathname: "/settings/setup-health",
  searchParams: new URLSearchParams(),
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => hiveContextMock.value,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMock.pathname,
  useSearchParams: () => navigationMock.searchParams,
}));

describe("SetupHealthPage", () => {
  beforeEach(() => {
    navigationMock.pathname = "/settings/setup-health";
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

  it("renders without crashing when no hive is selected and the context is empty", () => {
    hiveContextMock.value = {
      selected: null,
      hives: [],
      loading: false,
      selectHive: () => {},
    hasProvider: true,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<SetupHealthPage />);

    expect(screen.getByRole("heading", { name: "Setup health" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No hive selected" })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders safely while setup health is loading and then shows rows", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })),
    );

    render(<SetupHealthPage />);

    expect(screen.getByText("Checking setup health...")).toBeTruthy();
    expect(screen.queryByText("1 of 1 ready")).toBeNull();

    resolveFetch(
      jsonResponse({
        data: {
          hiveId: "hive-1",
          rows: [
            row("models", "Models", "ready", "Ready", "/setup/models", "Review Model Setup"),
          ],
        },
      }),
    );

    await waitFor(() => expect(screen.getByText("1 of 1 ready")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Models" })).toBeTruthy();
  });

  it("renders all setup health rows with owner-facing statuses and fix links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            data: {
              hiveId: "hive-1",
              rows: [
                row("models", "Models", "ready", "Ready", "/setup/models", "Review Model Setup"),
                row("ea", "EA", "not_set_up", "Not set up yet", "/setup/connectors", "Connect EA"),
                row("dispatcher", "Work queue", "ready", "Ready", "/tasks", "View work queue"),
                row(
                  "dashboard",
                  "Dashboard",
                  "ready",
                  "Ready",
                  "/setup/health",
                  "Review dashboard health",
                  "Dashboard responded at http://localhost:3002.",
                ),
                row("connectors", "Service connections", "pending", "Pending/not checked", "/setup/connectors", "Test connections"),
                row("safety", "Safety rules", "needs_attention", "Needs attention", "/setup/action-policies", "Review safety rules"),
                row("schedules", "Recurring work", "not_set_up", "Not set up yet", "/schedules", "Turn on recurring work"),
                row("memory", "Memory search", "needs_attention", "Needs attention", "/setup/embeddings", "Fix memory search"),
              ],
            },
          }),
        ),
      ),
    );

    render(<SetupHealthPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Setup health" })).toBeTruthy());
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/setup-health?hiveId=hive-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    for (const title of [
      "Models",
      "EA",
      "Work queue",
      "Dashboard",
      "Service connections",
      "Safety rules",
      "Recurring work",
      "Memory search",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }

    expect(screen.getByText("3 of 8 ready")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect EA" }).getAttribute("href")).toBe("/setup/connectors");
    expect(screen.getByRole("link", { name: "View work queue" }).getAttribute("href")).toBe("/tasks");
    expect(screen.getByRole("link", { name: "Review dashboard health" }).getAttribute("href")).toBe("/setup/health");
    expect(screen.getByRole("link", { name: "Review safety rules" }).getAttribute("href")).toBe("/setup/action-policies");
    expect(screen.getByRole("link", { name: "Turn on recurring work" }).getAttribute("href")).toBe("/schedules");
    expect(screen.getByRole("link", { name: "Fix memory search" }).getAttribute("href")).toBe("/setup/embeddings");
    expect(screen.getByText(/http:\/\/localhost:3002/)).toBeTruthy();

    const pageText = document.body.textContent ?? "";
    expect(pageText).not.toMatch(/adapter_config|raw model|cron|route hint|action_policies|effect_type|jsonb/i);
    expect(pageText).not.toMatch(/3000\/3001|localhost:3000|localhost:3001/);
    expect(within(screen.getByText("Service connections").closest("article")!).getByText("Pending/not checked")).toBeTruthy();
  });

  it("uses the query-backed target hive for setup-health and preserves target links", async () => {
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
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({
      data: {
        hiveId: "hive-2",
        rows: [row("connectors", "Service connections", "pending", "Pending/not checked", "/setup/connectors", "Test connections")],
      },
    })));
    vi.stubGlobal("fetch", fetchSpy);

    render(<SetupHealthPage />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      "/api/setup-health?hiveId=hive-2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(screen.getByText(/Target mode: viewing/)).toBeTruthy();
    expect(screen.getByText("Hive Two")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Return to active hive" }).getAttribute("href")).toBe("/settings/setup-health");
    expect(screen.getByRole("link", { name: "Test connections" }).getAttribute("href")).toBe("/setup/connectors?targetHiveId=hive-2");
  });

  it("fails closed for an unresolved setup-health target without querying the active hive", () => {
    navigationMock.searchParams = new URLSearchParams("targetHiveId=missing-hive");
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [{ id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" }],
      loading: false,
      selectHive: () => {},
    hasProvider: true,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<SetupHealthPage />);

    expect(screen.getByText(/Hive target/)).toBeTruthy();
    expect(screen.getByText("missing-hive")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("waits for target hive resolution before fetching setup health", () => {
    navigationMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [],
      loading: true,
      selectHive: () => {},
      hasProvider: true,
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    render(<SetupHealthPage />);

    expect(screen.getByText("Checking setup health...")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

function row(
  key: string,
  title: string,
  status: string,
  statusLabel: string,
  href: string,
  hrefLabel: string,
  summary?: string,
) {
  return {
    key,
    title,
    status,
    statusLabel,
    summary: summary ?? `${title} summary.`,
    href,
    hrefLabel,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
