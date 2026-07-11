// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SopImporterPage from "../../src/app/(dashboard)/setup/sop-importer/page";

const sopContextMock = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
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
  },
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => sopContextMock.value,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => sopContextMock.searchParams,
  usePathname: () => "/setup/sop-importer",
}));

describe("SopImporterPage target mode", () => {
  beforeEach(() => {
    sopContextMock.searchParams = new URLSearchParams();
    sopContextMock.value.selected = { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" };
    sopContextMock.value.hives = [
      { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      { id: "hive-2", slug: "hive-two", name: "Hive Two", type: "digital" },
    ];
    sopContextMock.value.hasProvider = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("imports SOP drafts against targetHiveId after destination confirmation", async () => {
    sopContextMock.searchParams = new URLSearchParams("targetHiveId=hive-2");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return jsonResponse({ data: { slug: "target-sop" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SopImporterPage />);

    expect(screen.getByText(/Target mode: viewing/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("e.g. Handle Lakes Bushland refund request"), {
      target: { value: "Target SOP" },
    });
    fireEvent.change(screen.getByPlaceholderText(/# Handle Lakes Bushland refund request/), {
      target: { value: "Do target hive workflow steps." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import SOP" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/skills/import" && init?.method === "POST");
      expect(postCall).toBeTruthy();
      expect(JSON.parse(postCall![1]!.body as string).hiveId).toBe("hive-2");
    });
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("will update Hive Two, not your active hive Hive One"));
  });

  it("fails closed for invalid targetHiveId without importing against the active hive", () => {
    sopContextMock.searchParams = new URLSearchParams("targetHiveId=missing-hive");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SopImporterPage />);

    expect(screen.getByText(/Hive target/).textContent).toContain("missing-hive");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
