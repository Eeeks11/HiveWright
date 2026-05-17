import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/app/api/_lib/db", () => ({ sql: mocks.sql }));
vi.mock("@/auth/users", () => ({ canAccessHive: mocks.canAccessHive }));

const { GET } = await import("@/app/api/deliverables/route");

const row = {
  id: "wp-1", hive_id: "hive-1", task_id: "task-1", goal_id: null, title: "Report", summary: null,
  filename: "report.md", mime_type: "text/markdown", render_mode: null, review_status: "ready",
  public_url: null, source_url: null, content: "body", artifact_kind: "document", file_path: null,
  source_task_title: "Task", source_goal_title: null, created_at: new Date("2026-05-16T00:00:00Z"),
};

describe("GET /api/deliverables", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ user: { id: "owner", isSystemOwner: true } });
    mocks.sql.mockResolvedValue([row]);
  });

  it("lists deliverable summaries for owners", async () => {
    const res = await GET(new Request("http://localhost/api/deliverables?hiveId=hive-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ id: "wp-1", title: "Report", renderMode: "markdown" });
  });

  it("requires hive access for non-owner users", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({ user: { id: "user-1", isSystemOwner: false } });
    mocks.canAccessHive.mockResolvedValueOnce(false);
    const res = await GET(new Request("http://localhost/api/deliverables?hiveId=hive-1"));
    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
  });
});
