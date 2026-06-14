// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TargetHiveBanner, UnresolvedHiveTargetMessage, useResolvedHiveTarget } from "../../src/components/hive-target-mode";

const mockState = vi.hoisted(() => ({
  pathname: "/hives/target-1/files",
  hiveContext: {
    hives: [
      { id: "active-1", slug: "active", name: "Active Hive", type: "business" },
      { id: "target-1", slug: "target", name: "Target Hive", type: "business" },
    ],
    selected: { id: "active-1", slug: "active", name: "Active Hive", type: "business" },
    loading: false,
    hasProvider: true,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockState.pathname,
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => mockState.hiveContext,
}));

function Probe({ routeHiveId }: { routeHiveId: string }) {
  const target = useResolvedHiveTarget(routeHiveId);
  return (
    <div>
      <div data-testid="effective">{target.effectiveHiveId ?? "none"}</div>
      <div data-testid="unresolved">{String(target.isUnresolvedTarget)}</div>
      <div data-testid="goals-href">{target.withTargetHiveId("/goals")}</div>
      <div data-testid="exit-href">{target.exitTargetHref}</div>
      <button type="button" onClick={() => target.confirmCrossHiveWrite("Saving budget changes")}>Confirm</button>
      <TargetHiveBanner activeHive={target.activeHive} targetHive={target.targetHive} exitHref={target.exitTargetHref} />
    </div>
  );
}

describe("target hive mode primitives", () => {
  it("resolves explicit route targets and persists targetHiveId into generic links", () => {
    render(<Probe routeHiveId="target-1" />);

    expect(screen.getByTestId("effective").textContent).toBe("target-1");
    expect(screen.getByTestId("unresolved").textContent).toBe("false");
    expect(screen.getByTestId("goals-href").textContent).toBe("/goals?targetHiveId=target-1");
    expect(screen.getByTestId("exit-href").textContent).toBe("/hives/active-1/files");
    expect(screen.getByText(/viewing/i).textContent).toContain("Target Hive");
    expect(screen.getByRole("link", { name: "Return to active hive" }).getAttribute("href")).toBe("/hives/active-1/files");
  });

  it("fails closed for invalid route targets instead of falling back to active hive", () => {
    render(<Probe routeHiveId="missing-hive" />);

    expect(screen.getByTestId("effective").textContent).toBe("none");
    expect(screen.getByTestId("unresolved").textContent).toBe("true");
    render(<UnresolvedHiveTargetMessage hiveId="missing-hive" />);
    expect(screen.getByText(/No active-hive fallback was used/i)).toBeTruthy();
  });

  it("uses a destination-named confirmation for cross-hive writes", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Probe routeHiveId="target-1" />);

    screen.getByRole("button", { name: "Confirm" }).click();
    expect(confirm).toHaveBeenCalledWith(
      "Saving budget changes will update Target Hive, not your active hive Active Hive. Continue?",
    );
    confirm.mockRestore();
  });
});
