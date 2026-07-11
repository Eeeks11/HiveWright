import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

import { GET } from "./route";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "goal-1" }) };

describe("GET /api/goals/[id]/attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("rejects callers without access to the owning hive before listing metadata", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([{ id: "goal-1", hive_id: "11111111-1111-4111-8111-111111111111" }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/goals/goal-1/attachments?hiveId=11111111-1111-4111-8111-111111111111"), params);

    expect(res.status).toBe(403);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "11111111-1111-4111-8111-111111111111");
  });

  it("allows system-owner callers without hive membership lookup", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }])
      .mockResolvedValueOnce([{ id: "goal-1", hive_id: "11111111-1111-4111-8111-111111111111" }])
      .mockResolvedValueOnce([
        {
          id: "att-1",
          filename: "handoff.md",
          mime_type: "text/markdown",
          size_bytes: "12",
          uploaded_at: new Date("2026-04-27T00:00:00Z"),
        },
      ]);

    const res = await GET(new Request("http://localhost/api/goals/goal-1/attachments?hiveId=11111111-1111-4111-8111-111111111111"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });
});
