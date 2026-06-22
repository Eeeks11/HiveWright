import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  getInternalTaskScope: vi.fn(),
  canAccessHive: vi.fn(),
  buildAnalystTelemetrySummary: vi.fn(),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
  getInternalTaskScope: mocks.getInternalTaskScope,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/operations/analyst-telemetry-summary", () => ({
  buildAnalystTelemetrySummary: mocks.buildAnalystTelemetrySummary,
}));

import { GET } from "./route";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_HIVE_ID = "22222222-2222-2222-2222-222222222222";

function request(hiveId = HIVE_ID) {
  return new Request(`http://localhost/api/analyst-telemetry?hiveId=${hiveId}`);
}

const summary = {
  checkedAt: "2026-06-03T00:01:00.000Z",
  hiveId: HIVE_ID,
  runtimeDrift: {
    dispatcherHeartbeat: { state: "fresh", ageMs: 1000, lastHeartbeatAt: "2026-06-03T00:00:00.000Z" },
    routeDrift: {
      status: "in_sync",
      declaredCandidates: 1,
      runtimeProjectedCandidates: 1,
      blockedRoutes: 0,
      quarantinedRoutes: 0,
      staleRoutes: 0,
      driftReasons: [],
    },
  },
  modelRouting: {
    policySource: "hive",
    totalRoutes: 1,
    routableRoutes: 1,
    disabledRoutes: 0,
    blockedRoutes: 0,
    unhealthyRoutes: 0,
    quarantinedRoutes: 0,
    staleRoutes: 0,
    freshRoutes: 1,
    unknownHealthRoutes: 0,
    onDemandUnknownHealthRoutes: 0,
    localRoutes: 0,
    automaticProbeRoutes: 1,
    onDemandProbeRoutes: 0,
    staleRouteRecovery: {
      staleRoutes: 0,
      automaticProbeRoutes: 1,
      recoveryEligibleRoutes: 0,
      recoveryBlockedRoutes: 0,
    },
    unknownHealthRecovery: {
      unknownHealthRoutes: 0,
      automaticProbeRoutes: 1,
      recoveryEligibleRoutes: 0,
      recoveryBlockedRoutes: 0,
    },
    excludedRouteInventory: {
      excludedRoutes: 0,
      unknownHealthRoutes: 0,
      automaticProbeRoutes: 0,
      onDemandProbeRoutes: 0,
      reasonCounts: {},
    },
    readinessPolicy: {
      criticalCapacityBasis: "no_routable_or_recoverable_route",
      justification: "Readiness treats route-pool capacity as critical only when there is neither a currently routable model route nor an enabled automatic route that probe recovery can restore; broader stale or unknown inventory remains warning-level drift for analyst follow-up.",
    },
    providerCounts: { openai: 1 },
    adapterCounts: { codex: 1 },
    activeRoutePool: {
      routes: 1,
      providerCounts: { openai: 1 },
      adapterCounts: { codex: 1 },
    },
  },
  notices: ["Runtime drift and model routing summaries are in sync."],
};

describe("GET /api/analyst-telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "analyst@example.com", isSystemOwner: false },
    });
    mocks.getInternalTaskScope.mockResolvedValue({ ok: true, scope: null });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.buildAnalystTelemetrySummary.mockResolvedValue(summary);
  });

  it("returns 401 for signed-out callers before checking hive data", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mocks.getInternalTaskScope).not.toHaveBeenCalled();
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.buildAnalystTelemetrySummary).not.toHaveBeenCalled();
  });

  it("returns 403 when a non-owner caller cannot access the hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(mocks.getInternalTaskScope).toHaveBeenCalledWith();
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", HIVE_ID);
    expect(mocks.buildAnalystTelemetrySummary).not.toHaveBeenCalled();
  });

  it("allows a least-privilege hive viewer to read the sanitized summary", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(summary);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", HIVE_ID);
    expect(mocks.buildAnalystTelemetrySummary).toHaveBeenCalledWith({
      sql: mocks.sql,
      hiveId: HIVE_ID,
    });
  });

  it("allows internal task-scoped analyst calls for the matching hive without owner intervention", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "internal-service-account", email: "service@hivewright.local", isSystemOwner: true },
    });
    mocks.getInternalTaskScope.mockResolvedValueOnce({
      ok: true,
      scope: { taskId: "task-1", hiveId: HIVE_ID, assignedTo: "performance-analyst", parentTaskId: null },
    });

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(summary);
    expect(mocks.getInternalTaskScope).toHaveBeenCalledWith();
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.buildAnalystTelemetrySummary).toHaveBeenCalledWith({
      sql: mocks.sql,
      hiveId: HIVE_ID,
    });
  });

  it("enforces internal task hive scope before system-owner bypass", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "internal-service-account", email: "service@hivewright.local", isSystemOwner: true },
    });
    mocks.getInternalTaskScope.mockResolvedValueOnce({
      ok: true,
      scope: { taskId: "task-1", hiveId: HIVE_ID, assignedTo: "system-health-auditor", parentTaskId: null },
    });

    const res = await GET(request(OTHER_HIVE_ID));

    expect(res.status).toBe(403);
    expect(mocks.getInternalTaskScope).toHaveBeenCalledWith();
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.buildAnalystTelemetrySummary).not.toHaveBeenCalled();
  });

  it("does not expose raw privileged detail in the route response", async () => {
    const res = await GET(request());
    const text = await res.text();

    expect(text).not.toContain("credential");
    expect(text).not.toContain("rawRow");
    expect(text).not.toContain("secret");
  });
});
