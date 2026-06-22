import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsMock = vi.hoisted(() => ({
  collectHiveWrightDiagnostics: vi.fn(),
}));

vi.mock("@/diagnostics/checks", () => diagnosticsMock);

describe("GET /api/readiness", () => {
  beforeEach(() => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockReset();
  });

  it("returns 200 when no critical diagnostics block useful work", async () => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
      checkedAt: "2026-05-24T08:15:00.000Z",
      summary: {
        severity: "warning",
        ready: true,
        counts: { ok: 1, info: 0, warning: 1, critical: 0 },
        ownerActionRequired: false,
      },
      diagnostics: [],
    });
    const { GET } = await import("../../src/app/api/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ready).toBe(true);
    expect(body.data.status).toBe("ready");
  });

  it("returns 503 when critical diagnostics block useful work", async () => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
      checkedAt: "2026-05-24T08:15:00.000Z",
      summary: {
        severity: "critical",
        ready: false,
        counts: { ok: 0, info: 0, warning: 0, critical: 1 },
        ownerActionRequired: true,
      },
      diagnostics: [],
    });
    const { GET } = await import("../../src/app/api/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.data.ready).toBe(false);
    expect(body.data.status).toBe("not_ready");
  });

  it("remains controller-global even when a hiveId query is supplied", async () => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
      checkedAt: "2026-05-24T08:15:00.000Z",
      summary: {
        severity: "warning",
        ready: true,
        counts: { ok: 1, info: 0, warning: 1, critical: 0 },
        ownerActionRequired: false,
      },
      diagnostics: [],
    });
    const { GET } = await import("../../src/app/api/readiness/route");

    const response = await GET(new Request("http://localhost/api/readiness?hiveId=b6b815ba-5109-4066-8a33-cc5560d3a0e1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ready).toBe(true);
    expect(diagnosticsMock.collectHiveWrightDiagnostics).toHaveBeenCalledWith();
  });
});
