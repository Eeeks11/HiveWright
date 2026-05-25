import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
  applyOwnerOutcomeReviewAction: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("../../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/outcomes/review-actions", () => ({
  applyOwnerOutcomeReviewAction: mocks.applyOwnerOutcomeReviewAction,
  isOwnerOutcomeReviewAction: (value: unknown) => [
    "accepted",
    "needs_revision",
    "archived",
    "converted_to_process_candidate",
  ].includes(String(value)),
}));

import { POST } from "./route";

const OUTCOME_ID = "11111111-1111-4111-8111-111111111111";
const HIVE_ID = "22222222-2222-4222-8222-222222222222";

describe("POST /api/outcomes/[id]/review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([{ hive_id: HIVE_ID }]);
    mocks.applyOwnerOutcomeReviewAction.mockResolvedValue({
      id: OUTCOME_ID,
      status: "accepted",
    });
  });

  it("applies an owner review action after hive access is checked", async () => {
    const response = await POST(
      new Request(`http://localhost/api/outcomes/${OUTCOME_ID}/review`, {
        method: "POST",
        body: JSON.stringify({ action: "accepted" }),
      }),
      { params: Promise.resolve({ id: OUTCOME_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "owner-1", HIVE_ID);
    expect(mocks.applyOwnerOutcomeReviewAction).toHaveBeenCalledWith(mocks.sql, {
      outcomeId: OUTCOME_ID,
      hiveId: HIVE_ID,
      action: "accepted",
      actorId: "owner-1",
      note: undefined,
    });
    expect(body.data.status).toBe("accepted");
  });

  it("rejects invalid actions before applying state changes", async () => {
    const response = await POST(
      new Request(`http://localhost/api/outcomes/${OUTCOME_ID}/review`, {
        method: "POST",
        body: JSON.stringify({ action: "reviewed" }),
      }),
      { params: Promise.resolve({ id: OUTCOME_ID }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.applyOwnerOutcomeReviewAction).not.toHaveBeenCalled();
  });

  it("rejects callers without hive mutation access", async () => {
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const response = await POST(
      new Request(`http://localhost/api/outcomes/${OUTCOME_ID}/review`, {
        method: "POST",
        body: JSON.stringify({ action: "accepted" }),
      }),
      { params: Promise.resolve({ id: OUTCOME_ID }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.applyOwnerOutcomeReviewAction).not.toHaveBeenCalled();
  });
});
