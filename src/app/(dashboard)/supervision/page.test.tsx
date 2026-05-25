// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SupervisionPage from "./page";

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: { id: "hive-1", name: "HiveWright" },
    loading: false,
  }),
}));

vi.mock("@/components/mobile-supervision-surface", () => ({
  MobileSupervisionSurface: ({ hiveId, hiveName }: { hiveId: string; hiveName: string }) => (
    <div>{`${hiveName}:${hiveId}`}</div>
  ),
}));

describe("SupervisionPage", () => {
  it("renders the selected hive mobile supervision surface", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SupervisionPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("HiveWright:hive-1")).toBeTruthy();
  });
});
