// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import BusinessOsIndexPage from "../../src/app/(dashboard)/business-os/page";

describe("BusinessOsIndexPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/hives") {
        return new Response(JSON.stringify({
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              slug: "wm",
              name: "Whiston Management",
              kind: "business",
              businessOs: {
                status: "audit_in_progress",
                mode: "existing_business",
                profileId: "profile-1",
                href: "/business-os/11111111-1111-4111-8111-111111111111",
                readiness: { state: "measured", averageScore: 42, label: "42% ready" },
                openGapsCount: 3,
                approvalsRequiredCount: 2,
                nextAction: "Review owner approvals",
              },
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              slug: "wm-unconfigured",
              name: "WM Unconfigured",
              kind: "business",
              businessOs: {
                status: "setup_required",
                mode: null,
                profileId: null,
                href: "/hives/22222222-2222-4222-8222-222222222222/business-os/setup",
                readiness: { state: "unknown", averageScore: null, label: "Not measured" },
                openGapsCount: 0,
                approvalsRequiredCount: 0,
                nextAction: "Set up or audit this business",
              },
            },
            {
              id: "33333333-3333-4333-8333-333333333333",
              slug: "research",
              name: "Research Hive",
              kind: "research",
              businessOs: null,
            },
          ],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders an owner-visible Business OS index with status affordances", async () => {
    render(<BusinessOsIndexPage />);

    expect(await screen.findByRole("heading", { name: "Business OS" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Whiston Management")).toBeTruthy());
    expect(screen.getByText((content) => content.includes("audit in progress"))).toBeTruthy();
    expect(screen.getByText("42% ready")).toBeTruthy();
    expect(screen.getByText("3 open gaps")).toBeTruthy();
    expect(screen.getByText("2 approvals")).toBeTruthy();
    expect(screen.getByText("Review owner approvals")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Whiston Management Business OS" }).getAttribute("href")).toBe("/business-os/11111111-1111-4111-8111-111111111111");

    expect(screen.getByText("WM Unconfigured")).toBeTruthy();
    expect(screen.getByText((content) => content.includes("setup required"))).toBeTruthy();
    expect(screen.getByText("Not measured")).toBeTruthy();
    expect(screen.getByText("0 open gaps")).toBeTruthy();
    expect(screen.getByText("0 approvals")).toBeTruthy();
    expect(screen.getByText("Set up or audit this business")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up or audit WM Unconfigured" }).getAttribute("href")).toBe("/hives/22222222-2222-4222-8222-222222222222/business-os/setup");
    expect(screen.queryByText("Research Hive")).toBeNull();
  });
});
