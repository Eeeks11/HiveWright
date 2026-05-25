// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeliverableDetailPage from "../../src/app/(dashboard)/deliverables/[id]/page";

const mocks = vi.hoisted(() => ({
  getDeliverable: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
  sql: vi.fn(),
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/deliverables/queries", () => ({
  getDeliverable: mocks.getDeliverable,
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));

describe("DeliverableDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a sandboxed HTML preview with source context and actions", async () => {
    mocks.getDeliverable.mockResolvedValueOnce({
      id: "deliverable-1",
      hiveId: "hive-1",
      taskId: "task-1",
      goalId: "goal-1",
      title: "Landing page draft",
      summary: "First draft ready for owner review.",
      filename: "landing.html",
      mimeType: "text/html",
      renderMode: "html",
      reviewStatus: "needs_review",
      openUrl: "/api/deliverables/deliverable-1/content",
      downloadUrl: "/api/deliverables/deliverable-1/download",
      sourceTaskTitle: "Build landing page",
      sourceGoalTitle: "Launch site",
      createdAt: "2026-05-16T20:00:00.000Z",
      content: "<h1>Hello</h1>",
      filePath: null,
      artifactKind: "text",
      publicUrl: null,
      sourceUrl: "projects/site/landing.html",
      workspacePath: null,
    });

    const { container } = render(await DeliverableDetailPage({ params: Promise.resolve({ id: "deliverable-1" }) }));

    expect(screen.getByRole("heading", { name: "Landing page draft" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full page" }).getAttribute("href")).toBe("/deliverables/deliverable-1/open");
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/api/deliverables/deliverable-1/download");
    expect(screen.getByRole("link", { name: "Raw" }).getAttribute("href")).toBe("/api/deliverables/deliverable-1/content");
    expect(screen.getByRole("link", { name: "Build landing page" }).getAttribute("href")).toBe("/tasks/task-1");
    expect(screen.getByRole("link", { name: "Launch site" }).getAttribute("href")).toBe("/goals/goal-1");

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("src")).toBe("/api/deliverables/deliverable-1/content");
    expect(iframe?.getAttribute("sandbox")).toBe("");
    expect(iframe?.getAttribute("sandbox") ?? "").not.toContain("allow-same-origin");
  });

  it("calls notFound when the deliverable is missing", async () => {
    mocks.getDeliverable.mockResolvedValueOnce(null);

    await expect(DeliverableDetailPage({ params: Promise.resolve({ id: "missing" }) })).rejects.toThrow("notFound");
    expect(mocks.notFound).toHaveBeenCalled();
  });
});
