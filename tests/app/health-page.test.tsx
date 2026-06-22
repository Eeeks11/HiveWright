// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardHealthPage from "../../src/app/(dashboard)/health/page";

describe("DashboardHealthPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("separates active runtime readiness from optional setup-debt warning sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                checkedAt: "2026-05-24T08:15:00.000Z",
                scope: {
                  kind: "controller_global",
                  label: "Controller-global runtime diagnostics",
                  summary: "/api/diagnostics reports controller-wide state; use /api/analyst-telemetry?hiveId=... for hive-scoped readiness evidence.",
                  hiveScopedReadinessEndpoint: "/api/analyst-telemetry?hiveId=...",
                },
                summary: {
                  severity: "warning",
                  ready: true,
                  counts: { ok: 8, info: 0, warning: 1, critical: 0 },
                  ownerActionRequired: false,
                },
                diagnostics: [
                  {
                    id: "providers.route_pool_capacity",
                    label: "Controller-global model route pool capacity",
                    severity: "warning",
                    summary: "Controller-wide route pool has 1/2 automatic model route(s) currently routable across all hives.",
                    checkedAt: "2026-05-24T08:15:00.000Z",
                  },
                ],
                setupReadiness: {
                  checkedAt: "2026-05-24T08:15:01.000Z",
                  warningSources: [
                    {
                      source: "ollama",
                      label: "Ollama",
                      status: "missing",
                      detail: "Ollama is not reachable at http://localhost:11434.",
                      nextStep: "Install/start Ollama on the HiveWright server, then run setup health again.",
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    render(<DashboardHealthPage />);

    await waitFor(() => expect(screen.getByText("Active runtime")).toBeTruthy());
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Readiness warning sources" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ollama" })).toBeTruthy();
    expect(screen.getByText("ollama: missing")).toBeTruthy();
    expect(screen.getByText(/operational debt, not owner-action escalations/i)).toBeTruthy();
    expect(screen.getByText(/controller-wide state/i)).toBeTruthy();
    expect(screen.getByText("Controller-global model route pool capacity")).toBeTruthy();
  });
});
