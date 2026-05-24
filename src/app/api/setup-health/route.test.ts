import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
  requireSystemOwner: vi.fn(),
  canAccessHive: vi.fn(),
  getHiveOperatorVerdict: vi.fn(),
  defaultEnvFilePath: vi.fn(() => "/repo/.env"),
  upsertEnvFileValue: vi.fn(() => ({ envFilePath: "/repo/.env", updated: true })),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/operations/operator-verdict", () => ({
  getHiveOperatorVerdict: mocks.getHiveOperatorVerdict,
}));

vi.mock("@/lib/env-file", () => ({
  defaultEnvFilePath: mocks.defaultEnvFilePath,
  upsertEnvFileValue: mocks.upsertEnvFileValue,
}));

import { GET, PATCH } from "./route";

describe("/api/setup-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HIVES_WORKSPACE_ROOT;
    delete process.env.NEXT_PUBLIC_DASHBOARD_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.HIVEWRIGHT_INTERNAL_BASE_URL;
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.BASE_URL;
    delete process.env.PORT;
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.getHiveOperatorVerdict.mockResolvedValue({
      status: "running",
      canRunNow: true,
      summary: "Hive is running.",
      blockers: [],
      signals: {},
      checkedAt: "2026-05-17T19:00:00.000Z",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the resolved hive workspace root", async () => {
    process.env.HIVES_WORKSPACE_ROOT = "/tmp/hw-health-hives";

    const res = await GET(new Request("http://localhost/api/setup-health"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      hiveWorkspaceRoot: "/tmp/hw-health-hives",
      envKey: "HIVES_WORKSPACE_ROOT",
      envFilePath: "/repo/.env",
      restartRequired: false,
      dashboard: {
        checkedUrls: ["http://localhost:3002"],
        reachableUrl: "http://localhost:3002",
      },
    });
  });

  it("writes HIVES_WORKSPACE_ROOT and returns the restart prompt", async () => {
    const res = await PATCH(new Request("http://localhost/api/setup-health", {
      method: "PATCH",
      body: JSON.stringify({ hiveWorkspaceRoot: "/tmp/next-hives" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.upsertEnvFileValue).toHaveBeenCalledWith(
      "HIVES_WORKSPACE_ROOT",
      "/tmp/next-hives",
    );
    expect(body.data).toMatchObject({
      hiveWorkspaceRoot: "/tmp/next-hives",
      restartRequired: true,
      restartMessage: "Restart the dispatcher and app for HIVES_WORKSPACE_ROOT to take effect.",
    });
  });

  it("reports owner-facing setup rows for a hive", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ total: 2, configured: 2 }])
      .mockResolvedValueOnce([{ installed: 0, disabled: 0, tested: 0, errors: 0 }])
      .mockResolvedValueOnce([{ config: { maxConcurrentTasks: 3 } }])
      .mockResolvedValueOnce([{ open: 1 }])
      .mockResolvedValueOnce([{ installed: 1, active: 1, tested: 0, errors: 0 }])
      .mockResolvedValueOnce([{ total: 2, enabled: 0 }])
      .mockResolvedValueOnce([{ total: 2, enabled: 0 }])
      .mockResolvedValueOnce([{ config: { enabled: false, prepareOnSetup: false } }])
      .mockResolvedValueOnce([]);

    process.env.NEXT_PUBLIC_DASHBOARD_URL = "http://localhost:3002";

    const res = await GET(new Request("http://localhost/api/setup-health?hiveId=hive-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "models",
          statusLabel: "Ready",
          href: "/setup/models",
        }),
        expect.objectContaining({
          key: "ea",
          statusLabel: "Not set up yet",
          href: "/setup/connectors",
        }),
        expect.objectContaining({
          key: "connectors",
          statusLabel: "Pending/not checked",
          href: "/setup/connectors",
        }),
        expect.objectContaining({
          key: "dashboard",
          statusLabel: "Ready",
          summary: expect.stringContaining("http://localhost:3002"),
          href: "/setup/health",
        }),
        expect.objectContaining({
          key: "schedules",
          statusLabel: "Not set up yet",
          href: "/schedules",
        }),
        expect.objectContaining({
          key: "memory",
          statusLabel: "Not set up yet",
          href: "/setup/embeddings",
        }),
      ]),
    );
    expect(body.data.operatorVerdict).toMatchObject({
      status: "running",
      canRunNow: true,
      summary: "Hive is running.",
    });
    expect(body.data.dashboard).toMatchObject({
      checkedUrls: ["http://localhost:3002"],
      reachableUrl: "http://localhost:3002",
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3002/",
      expect.objectContaining({ method: "HEAD", redirect: "manual" }),
    );
    expect(mocks.getHiveOperatorVerdict).toHaveBeenCalledWith(mocks.sql, { hiveId: "hive-1" });
    expect(body.data.sources).toMatchObject({
      models: "model_catalog, hive_models, model_health, and role_templates",
      schedules: "schedules",
    });
  });
});
