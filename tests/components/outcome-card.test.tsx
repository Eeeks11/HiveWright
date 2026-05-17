// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutcomeCard } from "@/components/outcomes/outcome-card";
import type { OwnerOutcomeSummary } from "@/outcomes/types";

const baseOutcome: OwnerOutcomeSummary = {
  id: "completion-1",
  goalId: "goal-1",
  hiveId: "hive-1",
  goalTitle: "Launch HiveWright landing page",
  summary: "Landing page is ready for owner review.",
  status: "unread",
  createdAt: "2026-05-17T02:00:00.000Z",
  evidenceWorkProductIds: ["wp-1"],
  primaryWorkProductId: "wp-1",
  primaryOpenUrl: "/deliverables/wp-1/open",
  primaryDetailUrl: "/deliverables/wp-1",
  primaryArtifactTitle: "HiveWright landing page",
  primaryArtifactRenderMode: "html",
  primaryActionLabel: "View output page",
};

describe("OutcomeCard", () => {
  it("makes the actual artifact the primary action when a final output exists", () => {
    render(<OutcomeCard outcome={baseOutcome} />);

    const primary = screen.getByRole("link", { name: "View output page" });
    expect(primary.getAttribute("href")).toBe("/deliverables/wp-1/open");
    expect(screen.getByRole("link", { name: "Review handoff" }).getAttribute("href")).toBe("/deliverables/wp-1");
    expect(screen.getByRole("link", { name: "Launch HiveWright landing page" }).getAttribute("href")).toBe("/goals/goal-1");
    expect(screen.queryByRole("link", { name: "Review final output" })).toBeNull();
  });

  it("falls back to goal review only when no artifact route is available", () => {
    render(<OutcomeCard outcome={{
      ...baseOutcome,
      primaryWorkProductId: null,
      primaryOpenUrl: null,
      primaryDetailUrl: null,
      primaryArtifactTitle: null,
      primaryArtifactRenderMode: null,
      primaryActionLabel: "Review final output",
    }} />);

    const fallback = screen.getByRole("link", { name: "Review final output" });
    expect(fallback.getAttribute("href")).toBe("/goals/goal-1");
    expect(screen.queryByRole("link", { name: "Review handoff" })).toBeNull();
  });
});
