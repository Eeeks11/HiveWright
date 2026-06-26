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
              },
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
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
    expect(screen.getByRole("link", { name: "Open Whiston Management Business OS" }).getAttribute("href")).toBe("/business-os/11111111-1111-4111-8111-111111111111");
    expect(screen.queryByText("Research Hive")).toBeNull();
  });
});
