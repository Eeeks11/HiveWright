import { describe, expect, it } from "vitest";
import {
  buildDashboardNavigation,
  dashboardNavigationGroupIsActive,
  dashboardNavigationLinkIsActive,
} from "../../src/navigation/dashboard-navigation";

describe("dashboard navigation model", () => {
  it("separates selected-hive setup from global HiveWright settings", () => {
    const groups = buildDashboardNavigation({
      activeHiveId: "hive-2",
      qualityFeedbackCount: 4,
      unreadOutcomesCount: 2,
    });
    const links = groups.flatMap((group) => group.links.map((link) => ({ ...link, groupId: group.id })));
    const setupLinks = links.filter((link) => link.groupId === "setup");
    const globalLinks = links.filter((link) => link.groupId === "global");

    expect(groups.map((group) => group.id)).toEqual([
      "dashboard",
      "work",
      "inbox",
      "schedules",
      "memory",
      "analytics",
      "operations",
      "setup",
      "global",
    ]);
    expect(groups.find((group) => group.id === "global")?.global).toBe(true);
    expect(groups.find((group) => group.id === "setup")).toMatchObject({
      label: "Hive Setup",
    });
    expect(groups.find((group) => group.id === "work")?.href).toBeUndefined();
    expect(groups.find((group) => group.id === "memory")?.href).toBeUndefined();

    expect(setupLinks.map((link) => link.id)).toEqual([
      "setup",
      "models",
      "connectors",
      "action-policies",
      "setup-health",
    ]);
    expect(globalLinks.map((link) => link.id)).toEqual([
      "hives",
      "global-settings",
      "adapter-settings",
      "embedding-settings",
      "work-intake-settings",
      "updates",
    ]);
    expect(links.find((link) => link.id === "global-settings")).toMatchObject({
      href: "/settings",
      label: "Global Settings",
      groupId: "global",
    });
    expect(links.find((link) => link.id === "updates")).toMatchObject({
      href: "/setup/updates",
      label: "HiveWright Updates",
      groupId: "global",
    });
    expect(links.find((link) => link.id === "deliverables")).toMatchObject({
      href: "/deliverables",
      label: "Final outputs",
      badgeCount: 2,
      groupId: "work",
    });
    expect(setupLinks.map((link) => link.href).filter((href) => href.startsWith("/settings"))).toEqual([]);
  });

  it("frames pipeline and capture routes as Procedures instead of separate Operations tools", () => {
    const groups = buildDashboardNavigation({ activeHiveId: "hive-2" });
    const links = groups.flatMap((group) => group.links.map((link) => ({ ...link, groupId: group.id })));
    const procedures = links.find((link) => link.href === "/pipelines");
    const operations = groups.find((group) => group.id === "operations");
    const work = groups.find((group) => group.id === "work");

    expect(procedures).toMatchObject({
      id: "procedures",
      label: "Procedures",
      groupId: "work",
    });
    expect(operations?.links.map((link) => link.href)).not.toContain("/setup/workflow-capture");
    expect(operations?.links.map((link) => link.href)).not.toContain("/setup/sop-importer");
    expect(procedures && dashboardNavigationLinkIsActive(procedures, "/pipelines")).toBe(true);
    expect(procedures && dashboardNavigationLinkIsActive(procedures, "/setup/workflow-capture")).toBe(true);
    expect(procedures && dashboardNavigationLinkIsActive(procedures, "/setup/sop-importer")).toBe(true);
    expect(work && dashboardNavigationGroupIsActive(work, "/setup/workflow-capture/session-1/review")).toBe(true);
  });
});
