import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDeliverableManifest } from "../../src/work-products/manifest";

function tempWorkspace() {
  return mkdtempSync(path.join(os.tmpdir(), "hw-manifest-"));
}

describe("loadDeliverableManifest", () => {
  it("loads .hivewright deliverable manifests and verifies workspace-contained files", async () => {
    const workspace = tempWorkspace();
    try {
      const taskId = "task-1";
      const deliverableDir = path.join(workspace, ".hivewright", "deliverables", taskId);
      mkdirSync(deliverableDir, { recursive: true });
      const reportPath = path.join(workspace, "reports", "market.md");
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, "# Market report\n", "utf8");
      writeFileSync(path.join(deliverableDir, "manifest.json"), JSON.stringify({
        deliverables: [
          {
            kind: "markdown",
            path: "reports/market.md",
            title: "Market report",
            summary: "A markdown report",
            reviewRequired: true,
            metadata: { audience: "owner" },
          },
          {
            kind: "external_url",
            url: "https://example.com/preview",
            title: "Hosted preview",
          },
        ],
      }), "utf8");

      const loaded = await loadDeliverableManifest({ hiveWorkspacePath: workspace, taskId });

      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({
        kind: "markdown",
        path: reportPath,
        title: "Market report",
        mimeType: "text/markdown",
        renderMode: "markdown",
        reviewRequired: true,
        filename: "market.md",
      });
      expect(loaded[1]).toMatchObject({
        kind: "external_url",
        publicUrl: "https://example.com/preview",
        renderMode: "external_url",
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects manifest entries that escape the hive workspace", async () => {
    const workspace = tempWorkspace();
    const outside = path.join(os.tmpdir(), `hw-outside-${Date.now()}.md`);
    try {
      writeFileSync(outside, "outside", "utf8");
      const taskId = "task-escape";
      const deliverableDir = path.join(workspace, "work-products", taskId);
      mkdirSync(deliverableDir, { recursive: true });
      writeFileSync(path.join(deliverableDir, "manifest.json"), JSON.stringify({
        deliverables: [{ kind: "file", path: outside, title: "Bad" }],
      }), "utf8");

      await expect(loadDeliverableManifest({ hiveWorkspacePath: workspace, taskId }))
        .rejects.toThrow(/escapes hive workspace/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });
});
