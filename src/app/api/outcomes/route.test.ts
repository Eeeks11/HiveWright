import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  listOwnerOutcomes: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/outcomes/queries", () => ({
  listOwnerOutcomes: mocks.listOwnerOutcomes,
}));

import { GET } from "./route";

const HIVE_ID = "22222222-2222-4222-8222-222222222222";

describe("GET /api/outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.listOwnerOutcomes.mockResolvedValue([]);
  });

  it("requires a hive id", async () => {
    const response = await GET(new Request("http://localhost/api/outcomes"));

    expect(response.status).toBe(400);
    expect(mocks.listOwnerOutcomes).not.toHaveBeenCalled();
  });

  it("rejects inaccessible hives", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const response = await GET(new Request(`http://localhost/api/outcomes?hiveId=${HIVE_ID}`));

    expect(response.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "owner-1", HIVE_ID);
    expect(mocks.listOwnerOutcomes).not.toHaveBeenCalled();
  });

  it("lists owner outcomes scoped to the requested hive", async () => {
    mocks.listOwnerOutcomes.mockResolvedValueOnce([
      {
        id: "completion-1",
        goalId: "goal-1",
        hiveId: HIVE_ID,
        goalTitle: "Selected hive handoff",
        summary: "Done.",
        whyItMatters: "Durable handoff.",
        recommendedNextAction: "Review it.",
        impactStatement: "Hive impact.",
        status: "new",
        createdAt: "2026-05-16T20:00:00.000Z",
        evidenceWorkProductIds: [],
        primaryWorkProductId: null,
        primaryOpenUrl: null,
        primaryDetailUrl: null,
        primaryArtifactTitle: null,
        primaryArtifactRenderMode: null,
        primaryActionLabel: "Review final output",
      },
    ]);

    const response = await GET(new Request(`http://localhost/api/outcomes?hiveId=${HIVE_ID}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.listOwnerOutcomes).toHaveBeenCalledWith(mocks.sql, { hiveId: HIVE_ID, limit: 100 });
    expect(body.data).toHaveLength(1);
    expect(body.data[0].hiveId).toBe(HIVE_ID);
  });
});
