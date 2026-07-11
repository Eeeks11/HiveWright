import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET } from "./route";

const HIVE_ID = "11111111-1111-4111-8111-111111111111";

describe("GET /api/memory/timeline explicit hive target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockReset();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
  });

  it("rejects missing hiveId before querying memory timeline", async () => {
    const res = await GET(new Request("http://localhost/api/memory/timeline"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects invalid hiveId before querying memory timeline", async () => {
    const res = await GET(new Request("http://localhost/api/memory/timeline?hiveId=not-a-uuid"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must be a valid UUID");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects non-owner callers that cannot access the requested hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.sql.mockResolvedValueOnce([{ id: HIVE_ID }]);
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request(`http://localhost/api/memory/timeline?hiveId=${HIVE_ID}`));

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", HIVE_ID);
  });

  it("counts and lists only entries for the requested hive", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ id: HIVE_ID }])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "memory-1", content: "alpha", created_at: new Date("2026-01-01T00:00:00Z") }]);

    const res = await GET(new Request(`http://localhost/api/memory/timeline?hiveId=${HIVE_ID}&store=hive_memory`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    const countQuery = Array.from(mocks.sql.mock.calls[1][0] as TemplateStringsArray).join(" ");
    const baseStoreQuery = Array.from(mocks.sql.mock.calls[2][0] as TemplateStringsArray).join(" ");
    expect(countQuery).toContain("WHERE hive_id =");
    expect(baseStoreQuery).toContain("WHERE hive_id =");
  });
});
