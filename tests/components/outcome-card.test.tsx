// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutcomeCard, OutcomeCardView } from "@/components/outcomes/outcome-card";
import type { OwnerOutcomeSummary } from "@/outcomes/types";

const baseOutcome: OwnerOutcomeSummary = {
  id: "completion-1",
  goalId: "goal-1",
  hiveId: "hive-1",
  goalTitle: "Launch HiveWright landing page",
  summary: "Landing page is ready for owner review.",
  whyItMatters: "The owner can inspect the actual launch page.",
  recommendedNextAction: "Open the page and accept it if ready.",
  impactStatement: "Business hive impact: a launch asset is ready for review.",
  status: "new",
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

  it("exposes owner review actions without making task artifacts primary", () => {
    render(<OutcomeCard outcome={baseOutcome} />);

    expect(screen.getByRole("button", { name: "Accept outcome" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs revision" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flag reusable idea" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive outcome" })).toBeTruthy();
    expect(screen.getByText("The owner can inspect the actual launch page.")).toBeTruthy();
    expect(screen.getByText("Open the page and accept it if ready.")).toBeTruthy();
    expect(screen.getByText("Business hive impact: a launch asset is ready for review.")).toBeTruthy();
    expect(screen.getByText("1 audit artifact")).toBeTruthy();
  });

  it("requires a revision note before submitting a needs revision action", () => {
    const actions: Array<{ action: OwnerOutcomeSummary["status"]; note?: string }> = [];

    render(
      <OutcomeCardView
        outcome={baseOutcome}
        onReviewAction={(action, note) => actions.push({ action, note })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Needs revision" }));

    const submitButton = screen.getByRole("button", { name: "Send revision request" });
    expect((submitButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Revision note"), {
      target: { value: "Tighten the owner summary and fix the launch URL." },
    });
    fireEvent.click(submitButton);

    expect(actions).toEqual([
      {
        action: "needs_revision",
        note: "Tighten the owner summary and fix the launch URL.",
      },
    ]);
  });
});
