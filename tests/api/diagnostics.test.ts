import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsMock = vi.hoisted(() => ({
  collectHiveWrightDiagnostics: vi.fn(),
}));

const setupReadinessMock = vi.hoisted(() => ({
  collectSetupRuntimeReadiness: vi.fn(),
  listSetupRuntimeReadinessWarnings: vi.fn(),
}));

vi.mock("@/diagnostics/checks", () => diagnosticsMock);
vi.mock("@/setup-readiness/runtime", () => setupReadinessMock);

describe("GET /api/diagnostics", () => {
  beforeEach(() => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockReset();
    setupReadinessMock.collectSetupRuntimeReadiness.mockReset();
    setupReadinessMock.listSetupRuntimeReadinessWarnings.mockReset();
    setupReadinessMock.collectSetupRuntimeReadiness.mockResolvedValue({
      checkedAt: "2026-05-24T08:15:01.000Z",
      runtimes: {},
    });
    setupReadinessMock.listSetupRuntimeReadinessWarnings.mockReturnValue([]);
  });

  it("returns grouped diagnostics without mutating runtime state", async () => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
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
    expect(body.data.scope).toEqual({
      kind: "controller_global",
      label: "Controller-global runtime diagnostics",
      summary: "/api/diagnostics reports controller-wide state; use /api/analyst-telemetry?hiveId=... for hive-scoped readiness evidence.",
      hiveScopedReadinessEndpoint: "/api/analyst-telemetry?hiveId=...",
    });
    expect(body.data.summary.severity).toBe("warning");
    expect(body.data.diagnostics[0].id).toBe("dispatcher.heartbeat");
    expect(body.data.setupReadiness.warningSources).toEqual([]);
    expect(diagnosticsMock.collectHiveWrightDiagnostics).toHaveBeenCalledTimes(1);
    expect(setupReadinessMock.collectSetupRuntimeReadiness).toHaveBeenCalledTimes(1);
  });

  it("surfaces optional setup-debt warning sources beside runtime diagnostics", async () => {
    const setupSnapshot = {
      checkedAt: "2026-05-24T08:15:01.000Z",
      runtimes: {
        ollama: {
          label: "Ollama",
          installed: false,
          status: "missing",
          detail: "Ollama command is not installed on this server.",
          nextStep: "Install/start Ollama on the HiveWright server, then run setup health again.",
        },
      },
    };
    const warningSources = [
      {
        source: "ollama",
        label: "Ollama",
        status: "missing",
        detail: "Ollama command is not installed on this server.",
        nextStep: "Install/start Ollama on the HiveWright server, then run setup health again.",
      },
    ];
    diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
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
      diagnostics: [],
    });
    setupReadinessMock.collectSetupRuntimeReadiness.mockResolvedValue(setupSnapshot);
    setupReadinessMock.listSetupRuntimeReadinessWarnings.mockReturnValue(warningSources);
    const { GET } = await import("../../src/app/api/diagnostics/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.summary.ready).toBe(true);
    expect(body.data.summary.ownerActionRequired).toBe(false);
    expect(body.data.setupReadiness).toEqual({
      checkedAt: "2026-05-24T08:15:01.000Z",
      warningSources,
    });
    expect(setupReadinessMock.listSetupRuntimeReadinessWarnings).toHaveBeenCalledWith(setupSnapshot);
  });
});
