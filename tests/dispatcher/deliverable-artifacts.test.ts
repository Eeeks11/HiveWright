import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { emitBinaryWorkProduct, emitWorkProduct } from "../../src/work-products/emitter";
import { emitTaskEvent } from "../../src/dispatcher/event-emitter";

function createSqlMock(workspace: string) {
  const calls: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...interpolations: unknown[]) => {
    const query = strings.join("?");
    calls.push(query);
    values.push(interpolations);
    if (query.includes("SELECT h.workspace_path")) {
      return Promise.resolve([{ workspace_path: workspace }]);
    }
    if (query.includes("INSERT INTO work_products")) {
      return Promise.resolve([{ id: "wp-1", title: interpolations.includes("Landing page") ? "Landing page" : null, filename: "landing.html" }]);
    }
    if (query.includes("pg_notify")) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.json = (value: unknown) => value as never;
  return { sql, calls, values };
}

describe("dispatcher deliverable artifact capture support", () => {
  it("emits non-image file-backed deliverables inside the hive workspace", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "hw-artifacts-"));
    try {
      const filePath = path.join(workspace, "preview", "landing.html");
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, "<h1>Hello</h1>", "utf8");
      const { sql, calls, values } = createSqlMock(workspace);

      const wp = await emitBinaryWorkProduct(sql, {
        taskId: "task-1",
        hiveId: "hive-1",
        roleSlug: "designer",
        department: "creative",
        content: "Created a landing page",
        summary: "Landing page draft",
        title: "Landing page",
        artifactKind: "html",
        filePath,
        mimeType: "text/html",
        renderMode: "html",
        reviewStatus: "needs_review",
        metadata: { reviewRequired: true },
      });

      expect(wp).toMatchObject({ id: "wp-1" });
      expect(calls.some((call) => call.includes("file_path") && call.includes("render_mode"))).toBe(true);
      expect(values.flat()).toContain("needs_review");
      expect(values.flat()).toContain("text/html");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects file-backed deliverables outside the hive workspace", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "hw-artifacts-"));
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    try {
      writeFileSync(outside, "nope", "utf8");
      const { sql } = createSqlMock(workspace);
      await expect(emitBinaryWorkProduct(sql, {
        taskId: "task-1",
        hiveId: "hive-1",
        roleSlug: "designer",
        department: null,
        content: "x",
        summary: "x",
        artifactKind: "file",
        filePath: outside,
        mimeType: "text/plain",
      })).rejects.toThrow(/escaped hive workspace/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it("task completion events can carry clickable deliverable links", async () => {
    const { sql, values } = createSqlMock(process.cwd());
    await emitTaskEvent(sql, {
      type: "task_completed",
      taskId: "task-1",
      title: "Build preview",
      assignedTo: "designer",
      hiveId: "hive-1",
      deliverables: [{ title: "Landing page", openUrl: "/deliverables/wp-1/open", reviewUrl: "/deliverables/wp-1" }],
    });

    const payload = JSON.parse(values[0][0] as string);
    expect(payload.deliverables).toEqual([
      { title: "Landing page", openUrl: "/deliverables/wp-1/open", reviewUrl: "/deliverables/wp-1" },
    ]);
    expect(payload.type).toBe("task_completed");
    expect(payload.timestamp).toEqual(expect.any(String));
  });

  it("emits external URL deliverables without requiring a file path", async () => {
    const { sql, values } = createSqlMock(process.cwd());
    await emitWorkProduct(sql, {
      taskId: "task-1",
      hiveId: "hive-1",
      roleSlug: "designer",
      department: null,
      content: "Hosted preview",
      summary: "Hosted preview",
      title: "Hosted preview",
      artifactKind: "external_url",
      mimeType: "text/uri-list",
      renderMode: "external_url",
      publicUrl: "https://example.com/preview",
    });

    expect(values.flat()).toContain("external_url");
    expect(values.flat()).toContain("https://example.com/preview");
  });
});
