// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarketingPage from "../../src/app/(dashboard)/marketing/page";
import { useHiveContext } from "@/components/hive-context";

vi.mock("@/components/hive-context", () => ({
  useHiveContext: vi.fn(),
}));

describe("MarketingPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "hive-1", slug: "hive-1", name: "Hive One", type: "business" },
      hives: [],
      selectHive: () => {},
      loading: false,
    });

    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/marketing?hiveId=hive-1") {
        return new Response(JSON.stringify({
          data: {
            activeCampaigns: [
              {
                id: "campaign-1",
                objective: "Launch a truthful paid ads pilot",
                status: "approved",
                channels: ["ads"],
                spendBudgetCents: 50000,
              },
            ],
            pendingApprovals: [],
            approvedQueuedAssets: [],
            contentCalendar: [],
            results: [],
            dataSources: [],
            loopState: { stageOrder: ["observe", "plan", "execute", "measure", "optimise"] },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("unexpected url", { status: 500 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("replaces the misleading start-spend action with execution-proof guidance", async () => {
    render(<MarketingPage />);

    await waitFor(() => expect(screen.getAllByText("Launch a truthful paid ads pilot").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Start paid ads spend" })).toBeNull();
    expect(screen.getByText(/Execution proof required before HiveWright can mark paid ads as running\./i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Evaluate paid policy" })).toBeTruthy();
  });
});
