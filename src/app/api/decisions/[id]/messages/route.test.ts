import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("@/decisions/owner-comment-wake", () => ({
  mirrorOwnerDecisionCommentToGoalComment: vi.fn(),
}));

import { canAccessHive, canMutateHive } from "@/auth/users";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { GET, POST } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "decision-1" }) };
const decisionRow = { hive_id: "11111111-1111-4111-8111-111111111111" };
const messageRow = {
  id: "message-1",
  decision_id: "decision-1",
  sender: "owner",
  content: "Approved",
  created_at: new Date("2026-05-01T00:00:00.000Z"),
};

describe("GET /api/decisions/[id]/messages access control", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
  });

  it("returns 401 for signed-out callers before resolving the decision hive", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/decisions/decision-1/messages?hiveId=11111111-1111-4111-8111-111111111111"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the owning hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mockSql.mockResolvedValueOnce([decisionRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/decisions/decision-1/messages?hiveId=11111111-1111-4111-8111-111111111111"), params);

    expect(res.status).toBe(403);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "11111111-1111-4111-8111-111111111111");
  });

  it("returns 200 after resolving the decision's owning hive for an allowed caller", async () => {
    mockSql.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mockSql
      .mockResolvedValueOnce([decisionRow])
      .mockResolvedValueOnce([messageRow]);

    const res = await GET(new Request("http://localhost/api/decisions/decision-1/messages?hiveId=11111111-1111-4111-8111-111111111111"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "message-1",
        decisionId: "decision-1",
        content: "Approved",
      }),
    ]);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "11111111-1111-4111-8111-111111111111");
    expect(mockSql).toHaveBeenCalledTimes(3);
  });
});

describe("POST /api/decisions/[id]/messages access control", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
    mockCanMutateHive.mockResolvedValue(true);
  });

  it("returns 403 before inserting when the caller cannot access the decision hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mockSql.mockResolvedValueOnce([decisionRow]);
    mockCanMutateHive.mockResolvedValueOnce(false);

    const res = await POST(
      new Request("http://localhost/api/decisions/decision-1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hiveId: "11111111-1111-4111-8111-111111111111", content: "Cross-hive write", sender: "owner" }),
      }),
      params,
    );

    expect(res.status).toBe(403);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "11111111-1111-4111-8111-111111111111");
  });

  it("does not let non-owner hive members spoof owner as sender", async () => {
    mockSql.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]);
    mockSql
      .mockResolvedValueOnce([decisionRow])
      .mockResolvedValueOnce([{ ...messageRow, sender: "system" }]);

    const res = await POST(
      new Request("http://localhost/api/decisions/decision-1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hiveId: "11111111-1111-4111-8111-111111111111", content: "Allowed member note", sender: "owner" }),
      }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.sender).toBe("system");
    expect(mockSql).toHaveBeenCalledTimes(3);
  });
});
