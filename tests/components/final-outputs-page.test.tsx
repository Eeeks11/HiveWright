// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinalOutputsPage } from "@/components/outcomes/final-outputs-page";
import { useHiveContext } from "@/components/hive-context";

vi.mock("@/components/hive-context", () => ({
  useHiveContext: vi.fn(),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FinalOutputsPage />
    </QueryClientProvider>,
  );
}

describe("FinalOutputsPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/outcomes?hiveId=hive-1") {
        return new Response(JSON.stringify({
          data: [
            {
              id: "completion-1",
              goalId: "goal-1",
              hiveId: "hive-1",
              goalTitle: "Hive 1 launch",
              summary: "Hive 1 final handoff.",
              whyItMatters: "Hive 1 can review the actual output.",
              recommendedNextAction: "Accept or request changes.",
              impactStatement: "Business hive impact: owner review is unblocked.",
              status: "new",
              createdAt: "2026-05-16T20:00:00.000Z",
              evidenceWorkProductIds: ["wp-1", "wp-2"],
              primaryWorkProductId: "wp-1",
              primaryOpenUrl: "/deliverables/wp-1/open",
              primaryDetailUrl: "/deliverables/wp-1",
              primaryArtifactTitle: "Hive 1 landing page",
              primaryArtifactRenderMode: "html",
              primaryActionLabel: "View output page",
            },
          ],
        }), { status: 200 });
      }
      if (url === "/api/outcomes?hiveId=hive-2") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("unexpected url", { status: 500 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads final outputs only for the selected hive", async () => {
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "hive-1", slug: "hive-1", name: "Hive One", type: "business" },
      hives: [],
      selectHive: () => {},
      loading: false,
    });

    renderPage();

    expect(screen.getByRole("heading", { name: "Final outputs" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("Hive 1 launch").length).toBeGreaterThan(0));
    expect(screen.getByText("Hive 1 final handoff.")).toBeTruthy();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/outcomes?hiveId=hive-1");
    expect(globalThis.fetch).not.toHaveBeenCalledWith("/api/outcomes");
  });

  it("shows an empty state for the selected hive without leaking other hives' outcomes", async () => {
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "hive-2", slug: "hive-2", name: "Hive Two", type: "business" },
      hives: [],
      selectHive: () => {},
      loading: false,
    });

    renderPage();

    await waitFor(() => expect(screen.getByText(/No final outputs yet/i)).toBeTruthy());
    expect(screen.queryByText("Hive 1 launch")).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/outcomes?hiveId=hive-2");
  });
});
