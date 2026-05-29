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

describe("SchedulesPage", () => {
  it("sends schedule requests to the existing work intake page", async () => {
    render(<SchedulesPage />);
    await screen.findByText(/No schedules yet/i);

    fireEvent.click(screen.getByRole("button", { name: /Request a schedule/i }));

    expect(pushMock).toHaveBeenCalledWith("/intake");
  });
});
