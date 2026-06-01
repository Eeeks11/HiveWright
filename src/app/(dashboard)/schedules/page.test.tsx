/* @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: { id: "hive-1", name: "Test Hive" },
    loading: false,
  }),
}));

import SchedulesPage from "./page";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  pushMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

const activeSchedule = {
  id: "schedule-1",
  hiveId: "hive-1",
  cronExpression: "*/15 * * * *",
  taskTemplate: { assignedTo: "dev-agent", title: "Check status" },
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdBy: "owner",
  originType: "custom",
  originKey: null,
};

describe("SchedulesPage", () => {
  it("sends schedule requests to the existing work intake page", async () => {
    render(<SchedulesPage />);
    await screen.findByText(/No schedules yet/i);

    fireEvent.click(screen.getByRole("button", { name: /Request a schedule/i }));

    expect(pushMock).toHaveBeenCalledWith("/intake");
  });

  it("keeps the original enabled state visible when pausing a schedule fails", async () => {
    fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/schedules") && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ error: "pause rejected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [activeSchedule] }),
      });
    });

    render(<SchedulesPage />);
    await screen.findByText("Active");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await screen.findByText("Schedule update failed: pause rejected");
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("keeps the schedule visible when deletion fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/schedules") && init?.method === "DELETE") {
        return Promise.resolve(new Response("delete rejected", { status: 500 }));
      }
      return Promise.resolve({ ok: true, json: async () => ({ data: [activeSchedule] }) });
    });

    render(<SchedulesPage />);
    await screen.findByText("Check status");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await screen.findByText("Schedule deletion failed: HTTP 500");
    expect(screen.getByText("Check status")).toBeTruthy();
  });
});
