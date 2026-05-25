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

vi.mock("@/hives/scoreboard", () => ({
  getHiveScoreboard: vi.fn(),
}));

import { canAccessHive } from "@/auth/users";
import { getHiveScoreboard } from "@/hives/scoreboard";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { GET } from "./route";

const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockGetHiveScoreboard = getHiveScoreboard as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "hive-1" }) };

describe("/api/hives/[id]/scoreboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(true);
    mockGetHiveScoreboard.mockResolvedValue({
      hive: { id: "hive-1", kind: "research", name: "Research Hive", currentOutcome: "Compare vendors", status: "active" },
      activeGoals: { count: 1, items: [] },
      blockedItems: { count: 0, items: [] },
      ownerActionsNeeded: { count: 0, items: [] },
      recentCompletions: { count: 0, items: [] },
      nextRecommendedAction: "Continue the active research goal.",
      emptyStateGuidance: "Add research records or goals.",
      kindMetrics: { kind: "research", questionsAnswered: 0, sourcesReviewed: 0, confidence: "unknown", unresolvedUnknowns: 0 },
    });
  });

  it("returns 401 before DB use for signed-out callers", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/hives/hive-1/scoreboard"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("requires access to the requested hive before returning the scoreboard", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1" }]);

    const res = await GET(new Request("http://localhost/api/hives/hive-1/scoreboard"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.hive.id).toBe("hive-1");
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockGetHiveScoreboard).toHaveBeenCalledWith(mockSql, "hive-1");
  });

  it("returns 403 without calling the query layer when the user cannot access the hive", async () => {
    mockSql.mockResolvedValueOnce([{ id: "hive-1" }]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/hives/hive-1/scoreboard"), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/hive access required/i);
    expect(mockGetHiveScoreboard).not.toHaveBeenCalled();
  });

  it("allows system owners without membership lookup", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mockSql.mockResolvedValueOnce([{ id: "hive-1" }]);

    const res = await GET(new Request("http://localhost/api/hives/hive-1/scoreboard"), params);

    expect(res.status).toBe(200);
    expect(mockCanAccessHive).not.toHaveBeenCalled();
    expect(mockGetHiveScoreboard).toHaveBeenCalledWith(mockSql, "hive-1");
  });
});
