import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
  return {
    sql,
    requireApiAuth: vi.fn(),
    requireSystemOwner: vi.fn(),
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireSystemOwner: mocks.requireSystemOwner,
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET, POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/adapter-config", {
    method: "POST",
    body: JSON.stringify(body),
  });
}


const HIVE_ID = "11111111-1111-4111-8111-111111111111";

describe("GET /api/adapter-config explicit hive target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockReset();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
  });

  it("rejects missing hiveId before listing adapter config", async () => {
    const res = await GET(new Request("http://localhost/api/adapter-config"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects invalid hiveId before listing adapter config", async () => {
    const res = await GET(new Request("http://localhost/api/adapter-config?hiveId=not-a-uuid"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId must be a valid UUID");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects non-owner callers that cannot access the target hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.sql.mockResolvedValueOnce([{ id: HIVE_ID }]);
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request(`http://localhost/api/adapter-config?hiveId=${HIVE_ID}`));

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", HIVE_ID);
  });

  it("lists only global plus requested-hive adapter config rows", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ id: HIVE_ID }])
      .mockResolvedValueOnce([
        { id: "global-config", hive_id: null, adapter_type: "auto", config: {}, created_at: new Date("2026-01-01T00:00:00Z") },
        { id: "hive-config", hive_id: HIVE_ID, adapter_type: "codex", config: {}, created_at: new Date("2026-01-02T00:00:00Z") },
      ]);

    const res = await GET(new Request(`http://localhost/api/adapter-config?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((row: { hiveId: string | null }) => row.hiveId)).toEqual([null, HIVE_ID]);
    const queryText = Array.from(mocks.sql.mock.calls[1][0] as TemplateStringsArray).join(" ");
    expect(queryText).toContain("hive_id IS NULL");
  });
});

describe("POST /api/adapter-config owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("preserves unauthenticated denial before the owner gate", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(request({
      adapterType: "codex",
      config: { model: "gpt-5.4" },
    }));

    expect(res.status).toBe(401);
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before saving config", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await POST(request({
      adapterType: "codex",
      config: { model: "gpt-5.4" },
    }));

    expect(res.status).toBe(403);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows system owners to update existing adapter config", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ id: "adapter-config-1" }])
      .mockResolvedValueOnce([]);

    const res = await POST(request({
      hiveId: "hive-1",
      adapterType: "codex",
      config: { model: "gpt-5.4" },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ id: "adapter-config-1", updated: true });
    expect(mocks.sql).toHaveBeenCalledTimes(2);
    expect(mocks.sql.json).toHaveBeenCalledWith({ model: "gpt-5.4" });
  });
});
