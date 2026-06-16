import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HIVE_ID = "00000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({ requireApiUser: vi.fn(), canAccessHive: vi.fn(), sql: vi.fn() }));
vi.mock("@/app/api/_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/app/api/_lib/db", () => ({ sql: mocks.sql }));
vi.mock("@/auth/users", () => ({ canAccessHive: mocks.canAccessHive }));

const { GET } = await import("@/app/api/deliverables/[id]/content/route");

function row(overrides = {}) {
  return { id: "wp-1", hive_id: HIVE_ID, task_id: "task-1", goal_id: null, title: "Report", summary: null,
    filename: "report.md", mime_type: "text/markdown", render_mode: null, review_status: "ready",
    public_url: null, source_url: null, content: "# DB content", artifact_kind: "document", file_path: null,
    source_task_title: "Task", source_goal_title: null, created_at: new Date("2026-05-16T00:00:00Z"), workspace_path: null, ...overrides };
}

describe("GET /api/deliverables/[id]/content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ user: { id: "owner", isSystemOwner: true } });
  });

  function allowHiveAndReturn(deliverable = row()) {
    mocks.sql.mockResolvedValueOnce([{ id: HIVE_ID }]).mockResolvedValueOnce([deliverable]);
  }

  function request(path: string) {
    return new Request(`http://localhost${path}?hiveId=${HIVE_ID}`);
  }

  it("serves DB-backed text content", async () => {
    allowHiveAndReturn();
    const res = await GET(request("/api/deliverables/wp-1/content"), { params: Promise.resolve({ id: "wp-1" }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# DB content");
  });

  it("serves HTML content with a sandbox CSP", async () => {
    allowHiveAndReturn(row({ content: "<script>parent.alert('nope')</script>", filename: "page.html", mime_type: "text/html", render_mode: "html" }));
    const res = await GET(request("/api/deliverables/wp-1/content"), { params: Promise.resolve({ id: "wp-1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("<script>");
  });

  it("serves files only when contained in the hive workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-deliverable-"));
    const filePath = path.join(workspace, "report.txt");
    fs.writeFileSync(filePath, "file content");
    allowHiveAndReturn(row({ content: null, file_path: filePath, workspace_path: workspace, mime_type: "text/plain" }));
    try {
      const res = await GET(request("/api/deliverables/wp-1/content"), { params: Promise.resolve({ id: "wp-1" }) });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("file content");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not proxy external URL deliverables", async () => {
    allowHiveAndReturn(row({ content: null, public_url: "https://example.com/report", render_mode: "external_url" }));
    const res = await GET(request("/api/deliverables/wp-1/content"), { params: Promise.resolve({ id: "wp-1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { publicUrl: "https://example.com/report" } });
  });
});
