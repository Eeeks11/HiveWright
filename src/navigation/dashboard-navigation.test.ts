import { describe, expect, it } from "vitest";
import { buildDashboardNavigation, dashboardNavigationGroupIsActive } from "./dashboard-navigation";

describe("dashboard navigation Marketing and Sales OS", () => {
  it("exposes Marketing as its own attention-system section", () => {
    const groups = buildDashboardNavigation({ activeHiveId: "hive-1" });
    const marketing = groups.find((group) => group.id === "marketing");
    const work = groups.find((group) => group.id === "work");

    expect(marketing).toEqual(
      expect.objectContaining({
        id: "marketing",
        label: "Marketing",
        href: "/marketing",
        links: [],
      }),
    );
    expect(work?.links.map((link) => link.id)).not.toContain("marketing");
    expect(dashboardNavigationGroupIsActive(marketing!, "/marketing")).toBe(true);
  });

  it("exposes Sales as a separate conversion-system section without nesting it under Marketing or Work", () => {
    const groups = buildDashboardNavigation({ activeHiveId: "hive-1" });
    const sales = groups.find((group) => group.id === "sales");
    const marketing = groups.find((group) => group.id === "marketing");
    const work = groups.find((group) => group.id === "work");

    expect(sales).toEqual(
      expect.objectContaining({
        id: "sales",
        label: "Sales",
        href: "/sales",
        links: [],
      }),
    );
    expect(marketing?.links.map((link) => link.id)).not.toContain("sales");
    expect(work?.links.map((link) => link.id)).not.toContain("sales");
    expect(dashboardNavigationGroupIsActive(sales!, "/sales")).toBe(true);
    expect(dashboardNavigationGroupIsActive(sales!, "/sales/leakage")).toBe(true);
  });
});
