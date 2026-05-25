import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsMock = vi.hoisted(() => ({
  collectHiveWrightDiagnostics: vi.fn(),
}));

vi.mock("@/diagnostics/checks", () => diagnosticsMock);

describe("GET /api/diagnostics", () => {
  beforeEach(() => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockReset();
  });

  it("returns grouped diagnostics without mutating runtime state", async () => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
      checkedAt: "2026-05-24T08:15:00.000Z",
      summary: {
        severity: "warning",
        ready: true,
        counts: { ok: 1, info: 0, warning: 1, critical: 0 },
        ownerActionRequired: false,
      },
      diagnostics: [
        {
          id: "dispatcher.heartbeat",
          label: "Dispatcher heartbeat",
          severity: "warning",
          summary: "Dispatcher heartbeat is stale.",
          checkedAt: "2026-05-24T08:15:00.000Z",
          recommendedAction: "Restart the dispatcher if it remains stale.",
        },
      ],
    });
    const { GET } = await import("../../src/app/api/diagnostics/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary.severity).toBe("warning");
    expect(body.data.diagnostics[0].id).toBe("dispatcher.heartbeat");
    expect(diagnosticsMock.collectHiveWrightDiagnostics).toHaveBeenCalledTimes(1);
  });
});
