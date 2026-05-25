import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { requestCreationPauseResumeApproval } from "./creation-pause-control-plane";

const hiveId = "11111111-1111-4111-8111-111111111111";

function pausedState() {
  return {
    paused: true,
    reason: "Manual recovery",
    pausedBy: "owner@example.com",
    updatedAt: "2026-05-20T00:00:00.000Z",
    operatingState: "paused" as const,
    pausedScheduleIds: ["22222222-2222-4222-8222-222222222222"],
  };
}

describe("requestCreationPauseResumeApproval", () => {
  it("serializes the approval lookup and insert for one pause state", async () => {
    const queries: string[] = [];
    const tx = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(String(strings));
        return [];
      }),
      { json: (value: unknown) => value },
    );
    const db = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        queries.push(String(strings));
        return [];
      }),
      {
        begin: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
        json: (value: unknown) => value,
      },
    );

    await requestCreationPauseResumeApproval(db as unknown as Sql, {
      hiveId,
      requestedBy: "owner@example.com",
      pauseInput: pausedState(),
    });

    expect(db.begin).toHaveBeenCalledTimes(1);
    expect(queries[0]).toContain("pg_advisory_xact_lock");
    const lockIndex = queries.findIndex((query) => query.includes("pg_advisory_xact_lock"));
    const lookupIndex = queries.findIndex((query) => query.includes("FROM decisions"));
    const insertIndex = queries.findIndex((query) => query.includes("INSERT INTO decisions"));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lookupIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(lockIndex);
  });
});
