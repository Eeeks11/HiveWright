import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { unsafe: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    requireSystemOwner: vi.fn(),
    canAccessHive: vi.fn(),
    provisionerFor: vi.fn(),
  };
});

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("../../../provisioning", () => ({
  provisionerFor: mocks.provisionerFor,
}));

vi.mock("../../../provisioning/status-cache", () => ({
  getCachedStatus: vi.fn(() => undefined),
  setCachedStatus: vi.fn(),
}));

import { GET, POST } from "./route";
import { GET as GET_GLOBAL_ROLES } from "./global/route";

describe("GET /api/roles read behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([]);
    mocks.sql.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]);
  });

  it("preserves the active-role filter while returning enriched role rows for an explicit hive", async () => {
    const res = await GET(new Request("http://localhost/api/roles?hiveId=11111111-1111-4111-8111-111111111111"));

    expect(res.status).toBe(200);
    // calls[0] = strict hive exists; calls[1] = sql`WHERE rt.active = true` fragment; calls[2] = main SELECT query
    expect(mocks.sql).toHaveBeenCalledTimes(4);
    const fragmentQuery = Array.from(mocks.sql.mock.calls[1][0] as TemplateStringsArray).join(" ");
    expect(fragmentQuery).toContain("rt.active");
    expect(fragmentQuery).toContain("WHERE rt.active = true");
  });

  it("rejects missing hiveId before returning roles", async () => {
    const res = await GET(new Request("http://localhost/api/roles"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });

  it("rejects invalid hiveId before returning roles", async () => {
    const res = await GET(new Request("http://localhost/api/roles?hiveId=not-a-uuid"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must be a valid UUID");
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });

  it("checks hive access before applying hive-scoped role overrides for non-owner callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "member@example.com", isSystemOwner: false },
    });

    const res = await GET(new Request("http://localhost/api/roles?hiveId=11111111-1111-4111-8111-111111111111"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "11111111-1111-4111-8111-111111111111");
  });

  it("rejects hive-scoped role reads when the caller cannot access the hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/roles?hiveId=11111111-1111-4111-8111-111111111111"));

    expect(res.status).toBe(403);
  });
});

describe("GET /api/roles/global read behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.sql.mockResolvedValue([]);
  });

  it("returns global role templates without requiring a hiveId", async () => {
    const res = await GET_GLOBAL_ROLES(new Request("http://localhost/api/roles/global"));

    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    const fragmentText = Array.from(mocks.sql.mock.calls[0][0] as TemplateStringsArray).join(" ");
    const queryText = Array.from(mocks.sql.mock.calls[1][0] as TemplateStringsArray).join(" ");
    expect(queryText).toContain("0::int AS active_count");
    expect(fragmentText).toContain("WHERE rt.active = true");
  });
});

describe("POST /api/roles owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.provisionerFor.mockReturnValue({
      check: vi.fn().mockResolvedValue({ satisfied: true, fixable: false, reason: "ok" }),
    });
  });

  it("rejects authenticated non-owner callers before mutating roles", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await POST(new Request("http://localhost/api/roles", {
      method: "POST",
      body: JSON.stringify({ slug: "dev-agent", active: false }),
    }));

    expect(res.status).toBe(403);
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows system owners to toggle role active state", async () => {
    mocks.sql.unsafe.mockResolvedValueOnce([]);
    mocks.sql.mockResolvedValueOnce([
      { adapter_type: "claude-code", recommended_model: "anthropic/claude-sonnet-4-6" },
    ]);

    const res = await POST(new Request("http://localhost/api/roles", {
      method: "POST",
      body: JSON.stringify({ slug: "dev-agent", active: false }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ slug: "dev-agent", updated: true });
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("active = $1");
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual([false, "dev-agent"]);
  });
});
