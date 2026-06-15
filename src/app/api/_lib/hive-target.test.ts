import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
  canMutateHive: mocks.canMutateHive,
}));

import {
  readHiveTarget,
  requireResourceOwnedByHive,
  requireStrictHiveTarget,
} from "./hive-target";

const HIVE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HIVE_ID = "22222222-2222-4222-8222-222222222222";

function dbReturning(...results: unknown[][]) {
  const db = vi.fn(async () => results.shift() ?? []);
  return db;
}

async function json(response: Response) {
  return await response.json() as { error?: string };
}

describe("strict hive target helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses required targets from query, body, and path sources", () => {
    expect(readHiveTarget({
      kind: "query",
      request: new Request(`http://localhost/api/example?hiveId=${HIVE_ID}`),
    })).toBe(HIVE_ID);
    expect(readHiveTarget({ kind: "body", body: { targetHiveId: OTHER_HIVE_ID }, key: "targetHiveId" })).toBe(OTHER_HIVE_ID);
    expect(readHiveTarget({ kind: "path", params: { id: HIVE_ID }, key: "id" })).toBe(HIVE_ID);
  });

  it("returns 400 before database access when the target is missing", async () => {
    const db = dbReturning([{ id: HIVE_ID }]);

    const result = await requireStrictHiveTarget(
      db as never,
      { id: "owner-1", isSystemOwner: true },
      { kind: "query", request: new Request("http://localhost/api/example") },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect((await json(result.response)).error).toBe("hiveId is required");
    }
    expect(db).not.toHaveBeenCalled();
  });

  it("returns 400 before database access when the target is not a UUID", async () => {
    const db = dbReturning([{ id: HIVE_ID }]);

    const result = await requireStrictHiveTarget(
      db as never,
      { id: "owner-1", isSystemOwner: true },
      { kind: "body", body: { hiveId: "not-a-uuid" } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect((await json(result.response)).error).toBe("hiveId must be a valid UUID");
    }
    expect(db).not.toHaveBeenCalled();
  });

  it("returns 404 for a nonexistent target before access checks", async () => {
    const db = dbReturning([]);

    const result = await requireStrictHiveTarget(
      db as never,
      { id: "user-1", isSystemOwner: false },
      { kind: "query", request: new Request(`http://localhost/api/example?hiveId=${HIVE_ID}`) },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect((await json(result.response)).error).toBe("Hive not found");
    }
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });

  it("returns 403 when a non-owner cannot access an existing target", async () => {
    const db = dbReturning([{ id: HIVE_ID }]);
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const result = await requireStrictHiveTarget(
      db as never,
      { id: "user-1", isSystemOwner: false },
      { kind: "query", request: new Request(`http://localhost/api/example?hiveId=${HIVE_ID}`) },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect((await json(result.response)).error).toBe("Forbidden: caller cannot access this hive");
    }
    expect(mocks.canAccessHive).toHaveBeenCalledWith(db, "user-1", HIVE_ID);
  });

  it("uses mutate checks for write targets", async () => {
    const db = dbReturning([{ id: HIVE_ID }]);
    mocks.canMutateHive.mockResolvedValueOnce(true);

    const result = await requireStrictHiveTarget(
      db as never,
      { id: "user-1", isSystemOwner: false },
      { kind: "body", body: { targetHiveId: HIVE_ID }, key: "targetHiveId" },
      { mode: "mutate", label: "targetHiveId" },
    );

    expect(result).toEqual({ ok: true, hiveId: HIVE_ID });
    expect(mocks.canMutateHive).toHaveBeenCalledWith(db, "user-1", HIVE_ID);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });

  it("requires system owners to provide a valid existing target", async () => {
    const missing = await requireStrictHiveTarget(
      dbReturning([{ id: HIVE_ID }]) as never,
      { id: "owner-1", isSystemOwner: true },
      { kind: "query", request: new Request("http://localhost/api/example") },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.response.status).toBe(400);

    const nonexistent = await requireStrictHiveTarget(
      dbReturning([]) as never,
      { id: "owner-1", isSystemOwner: true },
      { kind: "query", request: new Request(`http://localhost/api/example?hiveId=${HIVE_ID}`) },
    );
    expect(nonexistent.ok).toBe(false);
    if (!nonexistent.ok) expect(nonexistent.response.status).toBe(404);

    const ok = await requireStrictHiveTarget(
      dbReturning([{ id: HIVE_ID }]) as never,
      { id: "owner-1", isSystemOwner: true },
      { kind: "query", request: new Request(`http://localhost/api/example?hiveId=${HIVE_ID}`) },
    );
    expect(ok).toEqual({ ok: true, hiveId: HIVE_ID });
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.canMutateHive).not.toHaveBeenCalled();
  });

  it("checks optional resource ownership against the strict target", async () => {
    expect(requireResourceOwnedByHive(HIVE_ID, HIVE_ID, { resourceName: "Schedule" })).toEqual({ ok: true });

    const missing = requireResourceOwnedByHive(null, HIVE_ID, { resourceName: "Schedule" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(404);
      expect((await json(missing.response)).error).toBe("Schedule not found");
    }

    const mismatch = requireResourceOwnedByHive(OTHER_HIVE_ID, HIVE_ID, { resourceName: "Schedule" });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.response.status).toBe(403);
      expect((await json(mismatch.response)).error).toBe("Forbidden: schedule does not belong to this hive");
    }
  });
});
