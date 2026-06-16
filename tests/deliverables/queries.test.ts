import { describe, expect, it, vi } from "vitest";
import { fallbackFilename, fallbackTitle, listDeliverables, mapDeliverableRow } from "@/deliverables/queries";

const baseRow = {
  id: "wp-1",
  hive_id: "00000000-0000-4000-8000-000000000001",
  task_id: "task-1",
  goal_id: "goal-1",
  title: null,
  summary: "Summary first line\nmore detail",
  filename: null,
  mime_type: "text/markdown",
  render_mode: null,
  review_status: null,
  public_url: null,
  source_url: null,
  content: "# Hello",
  artifact_kind: "document",
  file_path: null,
  source_task_title: "Task title",
  source_goal_title: "Goal title",
  created_at: new Date("2026-05-16T00:00:00.000Z"),
};

describe("deliverable query helpers", () => {
  it("backfills title, filename, render mode, review status, and URLs", () => {
    const mapped = mapDeliverableRow(baseRow);
    expect(mapped.title).toBe("Summary first line");
    expect(mapped.filename).toBe("summary-first-line.md");
    expect(mapped.renderMode).toBe("markdown");
    expect(mapped.reviewStatus).toBe("ready");
    expect(mapped.openUrl).toBe("/api/deliverables/wp-1/content?hiveId=00000000-0000-4000-8000-000000000001");
    expect(mapped.downloadUrl).toBe("/api/deliverables/wp-1/download?hiveId=00000000-0000-4000-8000-000000000001");
  });

  it("uses task title and file basename fallbacks", () => {
    expect(fallbackTitle({ id: "2", title: null, summary: null, source_task_title: "Task", filename: null, file_path: null })).toBe("Task");
    expect(fallbackFilename({ id: "2", title: null, summary: null, source_task_title: null, filename: null, file_path: "/tmp/report.html" })).toBe("report.html");
  });

  it("maps list query rows to summaries", async () => {
    let query = "";
    const sql = vi.fn((strings: TemplateStringsArray) => {
      query = strings.join("?");
      return Promise.resolve([baseRow]);
    });
    const summaries = await listDeliverables(sql, { hiveId: "hive-1" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty("content");
    expect(sql).toHaveBeenCalledOnce();
    expect(query).toContain("WHEN wp.artifact_kind = 'landing_page' THEN 1");
    expect(query).toContain("WHEN wp.artifact_kind = 'image' THEN 2");
    expect(query).toContain("WHEN wp.artifact_kind = 'document' THEN 3");
    expect(query).toContain("WHEN wp.artifact_kind = 'report' THEN 4");
    expect(query.indexOf("WHEN wp.artifact_kind = 'final_artifact' THEN 0")).toBeLessThan(
      query.indexOf("wp.created_at DESC"),
    );
  });
});
