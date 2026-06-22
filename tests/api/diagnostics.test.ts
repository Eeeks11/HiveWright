import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsMock = vi.hoisted(() => ({
  collectHiveWrightDiagnostics: vi.fn(),
}));

const setupReadinessMock = vi.hoisted(() => ({
  collectSetupRuntimeReadiness: vi.fn(),
  listActiveSetupRuntimeSources: vi.fn(),
  listSetupRuntimeReadinessWarnings: vi.fn(),
}));

vi.mock("@/diagnostics/checks", () => diagnosticsMock);
vi.mock("@/setup-readiness/runtime", () => setupReadinessMock);

describe("GET /api/diagnostics", () => {
  beforeEach(() => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockReset();
    setupReadinessMock.collectSetupRuntimeReadiness.mockReset();
    setupReadinessMock.listActiveSetupRuntimeSources.mockReset();
    setupReadinessMock.listSetupRuntimeReadinessWarnings.mockReset();
    setupReadinessMock.collectSetupRuntimeReadiness.mockResolvedValue({
      checkedAt: "2026-05-24T08:15:01.000Z",
      runtimes: {},
    });
    setupReadinessMock.listActiveSetupRuntimeSources.mockResolvedValue([]);
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
    expect(setupReadinessMock.listSetupRuntimeReadinessWarnings).toHaveBeenCalledWith(setupSnapshot, {
      activeSources: [],
    });
  });

  it("passes active configured local runtime sources into setup-readiness warnings", async () => {
    const setupSnapshot = {
      checkedAt: "2026-05-24T08:15:01.000Z",
      runtimes: {
        ollama: {
          label: "Ollama",
          installed: false,
          status: "missing",
          detail: "Ollama is not reachable.",
          nextStep: "Start Ollama.",
        },
      },
    };
    const warningSources = [
      {
        source: "ollama",
        label: "Ollama",
        status: "missing",
        policy: "active_provider",
        detail: "Ollama is not reachable.",
        nextStep: "Start Ollama.",
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
    setupReadinessMock.listActiveSetupRuntimeSources.mockResolvedValue(["ollama"]);
    setupReadinessMock.listSetupRuntimeReadinessWarnings.mockReturnValue(warningSources);
    const { GET } = await import("../../src/app/api/diagnostics/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.setupReadiness.warningSources).toEqual(warningSources);
    expect(setupReadinessMock.listActiveSetupRuntimeSources).toHaveBeenCalledTimes(1);
    expect(setupReadinessMock.listSetupRuntimeReadinessWarnings).toHaveBeenCalledWith(setupSnapshot, {
      activeSources: ["ollama"],
    });
  });

  it("scopes setup-readiness active-provider policy to the requested hive", async () => {
    const hiveId = "22222222-2222-4222-8222-222222222222";
    const setupSnapshot = {
      checkedAt: "2026-06-22T00:00:00.000Z",
      runtimes: {
        "claude-code": {
          label: "Claude Code",
          installed: false,
          status: "missing",
          detail: "Claude Code command is not installed on this server.",
          nextStep: "Install Claude Code.",
        },
        gemini: {
          label: "Gemini CLI",
          installed: true,
          status: "check_required",
          detail: "Gemini CLI is installed, but auth was not checked.",
          nextStep: "Sign in to Gemini CLI.",
        },
      },
    };
    const warningSources = [
      {
        source: "claude-code",
        label: "Claude Code",
        status: "missing",
        policy: "optional_runtime",
        detail: "Claude Code command is not installed on this server.",
        nextStep: "Install Claude Code.",
      },
      {
        source: "gemini",
        label: "Gemini CLI",
        status: "check_required",
        policy: "optional_runtime",
        detail: "Gemini CLI is installed, but auth was not checked.",
        nextStep: "Sign in to Gemini CLI.",
      },
    ];
    diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
      checkedAt: "2026-06-22T00:00:00.000Z",
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
    setupReadinessMock.listActiveSetupRuntimeSources.mockResolvedValue(["ollama"]);
    setupReadinessMock.listSetupRuntimeReadinessWarnings.mockReturnValue(warningSources);
    const { GET } = await import("../../src/app/api/diagnostics/route");

    const response = await GET(new Request(`http://localhost/api/diagnostics?hiveId=${hiveId}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.setupReadiness.warningSources).toEqual(warningSources);
    expect(setupReadinessMock.listActiveSetupRuntimeSources).toHaveBeenCalledWith(expect.any(Function), { hiveId });
    expect(setupReadinessMock.listSetupRuntimeReadinessWarnings).toHaveBeenCalledWith(setupSnapshot, {
      activeSources: ["ollama"],
    });
  });

  it("rejects malformed hive-scoped diagnostics readiness requests", async () => {
    const { GET } = await import("../../src/app/api/diagnostics/route");

    const response = await GET(new Request("http://localhost/api/diagnostics?hiveId=not-a-uuid"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("hiveId must be a valid UUID");
    expect(setupReadinessMock.listActiveSetupRuntimeSources).not.toHaveBeenCalled();
  });
});
