// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NavLinks } from "../../src/components/nav-links";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: vi.fn(),
}));

import { usePathname } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";

function mockHiveContext() {
  vi.mocked(useHiveContext).mockReturnValue({
    selected: { id: "hive-2", slug: "hive-2", name: "Hive 2", type: "business" },
    hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
    loading: false,
    selectHive: () => {},
  });
}

function mockBriefCount(pendingQualityFeedback: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { flags: { pendingQualityFeedback } },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    ),
  );
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe("<NavLinks>", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links Ideas to the selected hive and marks it active on the hive ideas route", () => {
    vi.mocked(usePathname).mockReturnValue("/hives/hive-2/ideas");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "hive-2", slug: "hive-2", name: "Hive 2", type: "business" },
      hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    const ideasLink = screen.getByRole("link", { name: "Ideas" });
    expect(ideasLink.getAttribute("href")).toBe("/hives/hive-2/ideas");
    expect(ideasLink.getAttribute("aria-current")).toBe("page");
  });

  it("links Initiatives to the selected hive and marks it active on the hive initiatives route", () => {
    vi.mocked(usePathname).mockReturnValue("/hives/hive-2/initiatives");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "hive-2", slug: "hive-2", name: "Hive 2", type: "business" },
      hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    const initiativesLink = screen.getByRole("link", { name: "Initiatives" });
    expect(initiativesLink.getAttribute("href")).toBe("/hives/hive-2/initiatives");
    expect(initiativesLink.getAttribute("aria-current")).toBe("page");
  });

  it("falls back to the first hive when no hive is selected", () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: null,
      hives: [{ id: "hive-1", slug: "hive-1", name: "Hive 1", type: "business" }],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute("href")).toBe("/hives/hive-1/ideas");
    expect(screen.getByRole("link", { name: "Initiatives" }).getAttribute("href")).toBe("/hives/hive-1/initiatives");
  });

  it("renders Ideas and Initiatives without duplicate key warnings when no hives are available", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(usePathname).mockReturnValue("/hives");
    vi.mocked(useHiveContext).mockReturnValue({
      selected: null,
      hives: [],
      loading: false,
      selectHive: () => {},
    });

    renderWithQueryClient(<NavLinks />);

    const ideasLink = screen.getByRole("link", { name: "Ideas" });
    const initiativesLink = screen.getByRole("link", { name: "Initiatives" });
    expect(ideasLink.getAttribute("href")).toBe("/hives");
    expect(initiativesLink.getAttribute("href")).toBe("/hives");
    expect(ideasLink.closest("li")).not.toBe(initiativesLink.closest("li"));
    const consoleMessages = consoleError.mock.calls.map((call) => call.join(" "));
    expect(consoleMessages).not.toContainEqual(
      expect.stringContaining("Encountered two children with the same key"),
    );
  });

  it("uses top-level groups as disclosure buttons instead of links to first child pages", () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    const inboxButton = screen.getByRole("button", { name: /Inbox/ });
    const setupButton = screen.getByRole("button", { name: /Hive Setup/ });

    expect(inboxButton.getAttribute("aria-expanded")).not.toBe("true");
    expect(setupButton.getAttribute("aria-expanded")).not.toBe("true");
    expect(screen.queryByRole("link", { name: "Inbox" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Setup" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Quality feedback" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Models" })).toBeNull();

    fireEvent.click(inboxButton);
    expect(inboxButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Decisions" }).getAttribute("href")).toBe("/decisions");
    expect(screen.getByRole("link", { name: "Quality feedback" }).getAttribute("href")).toBe("/quality-feedback");
  });

  it("renders a single top-level control for each navigation group", () => {
    vi.mocked(usePathname).mockReturnValue("/setup/models");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    expect(screen.getByRole("navigation", { name: "Dashboard" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dashboard" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Schedules" }).getAttribute("href")).toBe("/schedules");
    expect(screen.getByRole("link", { name: "Analytics" }).getAttribute("href")).toBe("/analytics");

    for (const groupLabel of ["Work", "Inbox", "Memory", "Operations", "Hive Setup", "Global"]) {
      expect(screen.getByRole("button", { name: new RegExp(groupLabel) })).toBeTruthy();
      expect(screen.queryByRole("link", { name: groupLabel })).toBeNull();
    }

    expect(screen.queryByRole("link", { name: "Board" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Voice" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Docs" })).toBeNull();
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("href")).toBe("/setup");
    expect(screen.getByRole("link", { name: "Models" }).getAttribute("href")).toBe("/setup/models");
    expect(screen.getByRole("link", { name: "Setup Health" }).getAttribute("href")).toBe("/setup/health");
    expect(screen.getByRole("link", { name: "Hives" }).getAttribute("href")).toBe("/hives");
    expect(screen.getByRole("link", { name: "Global Settings" }).getAttribute("href")).toBe("/settings");
    expect(screen.getByRole("link", { name: "Adapters" }).getAttribute("href")).toBe("/settings/adapters");
    expect(screen.getByRole("link", { name: "Embedding settings" }).getAttribute("href")).toBe("/settings/embeddings");
    expect(screen.getByRole("link", { name: "Work Intake Classifier" }).getAttribute("href")).toBe("/settings/work-intake");
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("expands only the active route group and keeps the active child route clear", () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    const workButton = screen.getByRole("button", { name: /Work/ });
    const memoryButton = screen.getByRole("button", { name: /Memory/ });
    const tasksLink = screen.getByRole("link", { name: "Tasks" });

    expect(workButton.getAttribute("aria-expanded")).toBe("true");
    expect(memoryButton.getAttribute("aria-expanded")).not.toBe("true");
    expect(tasksLink.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Goals" }).getAttribute("href")).toBe("/goals");
    expect(screen.queryByRole("link", { name: "Memory Health" })).toBeNull();
  });

  it("moves expansion from Work to Memory when the current route changes", () => {
    vi.mocked(usePathname).mockReturnValue("/memory/timeline");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    const workButton = screen.getByRole("button", { name: /Work/ });
    const memoryButton = screen.getByRole("button", { name: /Memory/ });
    const timelineLink = screen.getByRole("link", { name: "Memory Timeline" });

    expect(workButton.getAttribute("aria-expanded")).not.toBe("true");
    expect(memoryButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("link", { name: "Tasks" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Goals" })).toBeNull();
    expect(timelineLink.getAttribute("href")).toBe("/memory/timeline");
    expect(timelineLink.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Memory Health" }).getAttribute("href")).toBe("/memory/health");
  });

  it("expands Global instead of Hive Setup for global settings routes and aliases", () => {
    vi.mocked(usePathname).mockReturnValue("/settings/adapters");
    mockHiveContext();
    mockBriefCount(0);

    renderWithQueryClient(<NavLinks />);

    const hiveSetupButton = screen.getByRole("button", { name: /Hive Setup/ });
    const globalButton = screen.getByRole("button", { name: /Global/ });
    const adaptersLink = screen.getByRole("link", { name: "Adapters" });

    expect(hiveSetupButton.getAttribute("aria-expanded")).not.toBe("true");
    expect(globalButton.getAttribute("aria-expanded")).toBe("true");
    expect(adaptersLink.getAttribute("href")).toBe("/settings/adapters");
    expect(adaptersLink.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: "Models" })).toBeNull();
  });

  it("shows a pending count badge for Quality feedback when ratings are waiting", async () => {
    vi.mocked(usePathname).mockReturnValue("/tasks");
    mockHiveContext();
    mockBriefCount(3);

    renderWithQueryClient(<NavLinks />);

    const inboxButton = screen.getByRole("button", { name: /Inbox/ });
    expect(inboxButton.getAttribute("aria-expanded")).not.toBe("true");
    expect(screen.queryByRole("link", { name: "Quality feedback" })).toBeNull();
    await waitFor(() => {
      expect(within(inboxButton).getByText("3").textContent).toContain("3");
    });
  });
});
