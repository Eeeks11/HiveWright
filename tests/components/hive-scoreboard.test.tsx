// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HiveScoreboard } from "@/components/hives/hive-scoreboard";

describe("HiveScoreboard", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/hives/hive-1/scoreboard") {
        return new Response(JSON.stringify({
          data: {
            hive: {
              id: "hive-1",
              kind: "research",
              name: "Vendor Research",
              currentOutcome: "Choose the best vendor",
              status: "active",
            },
            activeGoals: {
              count: 1,
              items: [{ id: "goal-1", title: "Compare shortlist", status: "active", href: "/goals/goal-1" }],
            },
            blockedItems: { count: 0, items: [] },
            ownerActionsNeeded: { count: 1, items: [{ id: "decision-1", title: "Approve source list", priority: "high", href: "/decisions/decision-1" }] },
            recentCompletions: { count: 1, items: [{ id: "completion-1", summary: "Reviewed three credible sources." }] },
            nextRecommendedAction: "Approve source list so the hive can continue.",
            emptyStateGuidance: "Add research records or goals so this hive has evidence to work from.",
            kindMetrics: {
              kind: "research",
              questionsAnswered: 2,
              sourcesReviewed: 3,
              confidence: "medium",
              unresolvedUnknowns: 1,
            },
          },
        }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders what changed, what matters, and what next with kind-specific language", async () => {
    render(<HiveScoreboard hiveId="hive-1" hiveKind="research" />);

    expect(await screen.findByText("Hive scoreboard")).toBeTruthy();
    expect(screen.getByText("Choose the best vendor")).toBeTruthy();
    expect(screen.getByText("Approve source list so the hive can continue.")).toBeTruthy();
    expect(screen.getByText("Questions answered")).toBeTruthy();
    expect(screen.getByText("Sources reviewed")).toBeTruthy();
    expect(screen.getByText("Owner actions")).toBeTruthy();
    expect(screen.queryByText("Revenue")).toBeNull();

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/hives/hive-1/scoreboard");
    });
  });

  it("renders target links for rows with target metadata and informational labels for rows without targets", async () => {
    render(<HiveScoreboard hiveId="hive-1" hiveKind="research" />);

    const whatChanged = await screen.findByRole("heading", { name: "What changed" });
    const whatChangedSection = whatChanged.closest("div");
    expect(whatChangedSection).toBeTruthy();
    expect(within(whatChangedSection as HTMLElement).getByText("Informational")).toBeTruthy();
    expect(within(whatChangedSection as HTMLElement).queryByRole("link")).toBeNull();

    const matters = screen.getByRole("heading", { name: "What matters" }).closest("div");
    expect(matters).toBeTruthy();
    const decisionLink = within(matters as HTMLElement).getByRole("link", { name: /Approve source list/i });
    expect(decisionLink.getAttribute("href")).toBe("/decisions/decision-1");

    const activeGoals = screen.getByRole("heading", { name: "Active goals" }).closest("div");
    expect(activeGoals).toBeTruthy();
    const goalLink = within(activeGoals as HTMLElement).getByRole("link", { name: /Compare shortlist/i });
    expect(goalLink.getAttribute("href")).toBe("/goals/goal-1");
  });
});
