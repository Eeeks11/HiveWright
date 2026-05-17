import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mocks = vi.hoisted(() => ({ requireApiUser: vi.fn(), canAccessHive: vi.fn(), sql: vi.fn() }));
vi.mock("@/app/api/_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/app/api/_lib/db", () => ({ sql: mocks.sql }));
vi.mock("@/auth/users", () => ({ canAccessHive: mocks.canAccessHive }));

const { GET } = await import("@/app/api/deliverables/[id]/download/route");

function row(overrides = {}) {
  return { id: "wp-1", hive_id: "hive-1", task_id: "task-1", goal_id: null, title: "Report", summary: null,
    filename: "report.md", mime_type: "text/markdown", render_mode: null, review_status: "ready",
    public_url: null, source_url: null, content: "# DB content", artifact_kind: "document", file_path: null,
    source_task_title: "Task", source_goal_title: null, created_at: new Date("2026-05-16T00:00:00Z"), workspace_path: null, ...overrides };
}

describe("GET /api/deliverables/[id]/download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ user: { id: "owner", isSystemOwner: true } });
  });

  it("downloads DB-backed text content as an attachment", async () => {
    mocks.sql.mockResolvedValueOnce([row()]);
    const res = await GET(new Request("http://localhost/api/deliverables/wp-1/download"), { params: Promise.resolve({ id: "wp-1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("report.md");
    expect(await res.text()).toBe("# DB content");
  });

  it("rejects file paths outside the hive workspace", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hw-deliverable-"));
    const outside = path.join(os.tmpdir(), "outside-report.txt");
    fs.writeFileSync(outside, "nope");
    mocks.sql.mockResolvedValueOnce([row({ content: null, file_path: outside, workspace_path: workspace, mime_type: "text/plain" })]);
    try {
      const res = await GET(new Request("http://localhost/api/deliverables/wp-1/download"), { params: Promise.resolve({ id: "wp-1" }) });
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it("does not proxy external URL downloads", async () => {
    mocks.sql.mockResolvedValueOnce([row({ content: null, public_url: "https://example.com/report", render_mode: "external_url" })]);
    const res = await GET(new Request("http://localhost/api/deliverables/wp-1/download"), { params: Promise.resolve({ id: "wp-1" }) });
    expect(res.status).toBe(409);
  });
});
