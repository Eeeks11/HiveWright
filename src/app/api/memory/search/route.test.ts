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

describe("GET /api/memory/search explicit hive target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockReset();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
  });

  it("rejects missing hiveId before searching memory", async () => {
    const res = await GET(new Request("http://localhost/api/memory/search?q=alpha"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects invalid hiveId before searching memory", async () => {
    const res = await GET(new Request("http://localhost/api/memory/search?hiveId=not-a-uuid&q=alpha"));
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

    const res = await GET(new Request(`http://localhost/api/memory/search?hiveId=${HIVE_ID}&q=alpha`));

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", HIVE_ID);
  });

  it("queries every memory store with the requested hive only", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ id: HIVE_ID }])
      .mockResolvedValueOnce([{ id: "role-1", content: "alpha", updated_at: new Date("2026-01-03T00:00:00Z") }])
      .mockResolvedValueOnce([{ id: "hive-1", content: "beta", updated_at: new Date("2026-01-02T00:00:00Z") }])
      .mockResolvedValueOnce([{ id: "insight-1", content: "gamma", updated_at: new Date("2026-01-01T00:00:00Z") }]);

    const res = await GET(new Request(`http://localhost/api/memory/search?hiveId=${HIVE_ID}&q=alpha`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(3);
    const queryTexts = mocks.sql.mock.calls.slice(1).map((call) => Array.from(call[0] as TemplateStringsArray).join(" "));
    expect(queryTexts).toHaveLength(3);
    expect(queryTexts.every((text) => text.includes("WHERE hive_id ="))).toBe(true);
  });
});
