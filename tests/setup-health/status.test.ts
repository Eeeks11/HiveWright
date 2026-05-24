import { describe, expect, it } from "vitest";
import { buildSetupHealthRows, type SetupHealthSnapshot } from "@/setup-health/status";

const baseSnapshot: SetupHealthSnapshot = {
  roles: { total: 3, configured: 3 },
  ea: { installed: true, disabled: false, lastTested: true, hasError: false },
  dispatcher: { configured: true, maxConcurrentAgents: 3, openTasks: 0 },
  connectors: { installed: 1, active: 1, tested: 1, withErrors: 0 },
  actionPolicies: {
    total: 4,
    enabled: 4,
    blocksDestructive: true,
    requiresApprovalForExternalWrites: true,
  },
  schedules: { total: 2, enabled: 2 },
  memory: {
    requested: true,
    disabled: false,
    embeddingConfigured: true,
    embeddingStatus: "ready",
    embeddingError: false,
  },
  dashboard: {
    checkedUrls: ["http://localhost:3002"],
    reachableUrl: "http://localhost:3002",
    lastError: null,
  },
};

describe("buildSetupHealthRows", () => {
  it("maps a fully prepared hive to ready owner-facing rows", () => {
    const rows = buildSetupHealthRows(baseSnapshot);

    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ["models", "ready"],
      ["ea", "ready"],
      ["dispatcher", "ready"],
      ["dashboard", "ready"],
      ["connectors", "ready"],
      ["safety", "ready"],
      ["schedules", "ready"],
      ["memory", "ready"],
    ]);
    expect(rows.every((row) => row.statusLabel === "Ready")).toBe(true);
    expect(rows.map((row) => row.href)).toEqual([
      "/setup/models",
      "/setup/connectors",
      "/tasks",
      "/setup/health",
      "/setup/connectors",
      "/setup/action-policies",
      "/schedules",
      "/memory/health",
    ]);
  });

  it("reports the configured dashboard URL instead of assuming only 3000 or 3001 matter", () => {
    const rows = buildSetupHealthRows({
      ...baseSnapshot,
      dashboard: {
        checkedUrls: ["http://localhost:3002"],
        reachableUrl: "http://localhost:3002",
        lastError: null,
      },
    });

    const dashboard = rows.find((row) => row.key === "dashboard");
    expect(dashboard).toMatchObject({
      title: "Dashboard",
      status: "ready",
      href: "/setup/health",
    });
    expect(dashboard?.summary).toContain("http://localhost:3002");
    expect(dashboard?.summary).not.toMatch(/3000|3001/);
  });

  it("represents deferred EA setup and skipped connectors honestly", () => {
    const rows = buildSetupHealthRows({
      ...baseSnapshot,
      ea: { installed: false, disabled: false, lastTested: false, hasError: false },
      connectors: { installed: 0, active: 0, tested: 0, withErrors: 0 },
    });

    expect(rows.find((row) => row.key === "ea")).toMatchObject({
      status: "not_set_up",
      statusLabel: "Not set up yet",
      href: "/setup/connectors",
    });
    expect(rows.find((row) => row.key === "connectors")).toMatchObject({
      status: "not_set_up",
      statusLabel: "Not set up yet",
      href: "/setup/connectors",
    });
  });

  it("marks untested connectors and memory preparation as pending", () => {
    const rows = buildSetupHealthRows({
      ...baseSnapshot,
      connectors: { installed: 2, active: 2, tested: 1, withErrors: 0 },
      memory: {
        requested: true,
        disabled: false,
        embeddingConfigured: true,
        embeddingStatus: "reembedding",
        embeddingError: false,
      },
    });

    expect(rows.find((row) => row.key === "connectors")?.statusLabel).toBe("Pending/not checked");
    expect(rows.find((row) => row.key === "memory")?.statusLabel).toBe("Pending/not checked");
  });

  it("flags missing safety policies before real work starts", () => {
    const rows = buildSetupHealthRows({
      ...baseSnapshot,
      actionPolicies: {
        total: 0,
        enabled: 0,
        blocksDestructive: false,
        requiresApprovalForExternalWrites: false,
      },
    });

    const safety = rows.find((row) => row.key === "safety");
    expect(safety).toMatchObject({
      title: "Safety rules",
      status: "needs_attention",
      statusLabel: "Needs attention",
      href: "/setup/action-policies",
      hrefLabel: "Review safety rules",
    });
    expect(safety?.summary).toMatch(/approval|block|safe/i);
  });

  it("requires destructive actions to be blocked and external writes to require approval", () => {
    const rows = buildSetupHealthRows({
      ...baseSnapshot,
      actionPolicies: {
        total: 3,
        enabled: 3,
        blocksDestructive: false,
        requiresApprovalForExternalWrites: true,
      },
    });

    expect(rows.find((row) => row.key === "safety")).toMatchObject({
      status: "needs_attention",
      href: "/setup/action-policies",
    });
  });
});
