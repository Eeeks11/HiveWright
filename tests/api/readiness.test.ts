import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnosticsMock = vi.hoisted(() => ({
  collectHiveWrightDiagnostics: vi.fn(),
}));

vi.mock("@/diagnostics/checks", () => diagnosticsMock);

const controllerGlobalScope = {
  kind: "controller_global",
  label: "Controller-global runtime diagnostics",
  summary:
    "/api/diagnostics reports controller-wide app, queue, execution-run, provider, and route-pool state across all hives; use /api/analyst-telemetry?hiveId=... for hive-scoped readiness evidence.",
  hiveScopedReadinessEndpoint: "/api/analyst-telemetry?hiveId=...",
} as const;

function mockDiagnostics(input: {
  ready: boolean;
  severity: "warning" | "critical";
  ownerActionRequired: boolean;
  counts: { ok: number; info: number; warning: number; critical: number };
}) {
  diagnosticsMock.collectHiveWrightDiagnostics.mockResolvedValue({
    checkedAt: "2026-05-24T08:15:00.000Z",
    scope: controllerGlobalScope,
    summary: {
      severity: input.severity,
      ready: input.ready,
      counts: input.counts,
      ownerActionRequired: input.ownerActionRequired,
    },
    diagnostics: [],
    recentFailureGroups: [],
  });
}

describe("GET /api/readiness", () => {
  beforeEach(() => {
    diagnosticsMock.collectHiveWrightDiagnostics.mockReset();
  });

  it("returns 200 when no critical diagnostics block useful work", async () => {
    mockDiagnostics({
      severity: "warning",
      ready: true,
      counts: { ok: 1, info: 0, warning: 1, critical: 0 },
      ownerActionRequired: false,
    });
    const { GET } = await import("../../src/app/api/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ready).toBe(true);
    expect(body.data.status).toBe("ready");
  });

  it("returns 503 when critical diagnostics block useful work", async () => {
    mockDiagnostics({
      severity: "critical",
      ready: false,
      counts: { ok: 0, info: 0, warning: 0, critical: 1 },
      ownerActionRequired: true,
    });
    const { GET } = await import("../../src/app/api/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.data.ready).toBe(false);
    expect(body.data.status).toBe("not_ready");
  });

  it("identifies the readiness summary as controller-global", async () => {
    mockDiagnostics({
      severity: "warning",
      ready: true,
      counts: { ok: 1, info: 0, warning: 1, critical: 0 },
      ownerActionRequired: false,
    });
    const { GET } = await import("../../src/app/api/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.scope).toEqual(controllerGlobalScope);
    expect(body.data.scope.kind).toBe("controller_global");
    expect(body.data.scopeNotice).toContain("controller-wide");
  });

  it("does not imply hive-scoped readiness when hiveId is supplied", async () => {
    mockDiagnostics({
      severity: "warning",
      ready: true,
      counts: { ok: 1, info: 0, warning: 1, critical: 0 },
      ownerActionRequired: false,
    });
    const { GET } = await import("../../src/app/api/readiness/route");

    const response = await GET(new Request("http://localhost/api/readiness?hiveId=hive_123"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.scope.kind).toBe("controller_global");
    expect(body.data.requestedHiveId).toBe("hive_123");
    expect(body.data.scopeNotice).toContain("hiveId=hive_123 was not used");
    expect(body.data.scopeNotice).toContain("/api/analyst-telemetry?hiveId=...");
    expect(body.data.hiveScopedReadinessEndpoint).toBe("/api/analyst-telemetry?hiveId=...");
  });
});
