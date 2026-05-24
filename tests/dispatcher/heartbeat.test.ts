import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  loadDispatcherHeartbeatStatus,
  recordDispatcherHeartbeat,
} from "@/dispatcher/heartbeat";

describe("dispatcher heartbeat", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("records and classifies a fresh dispatcher heartbeat", async () => {
    const checkedAt = new Date("2026-05-24T08:15:00.000Z");

    await recordDispatcherHeartbeat(sql, {
      dispatcherId: "dispatcher-test",
      pid: 4242,
      hostId: "host-a",
      version: "0.1.4",
      buildHash: "abc123",
      now: checkedAt,
    });

    const status = await loadDispatcherHeartbeatStatus(sql, {
      dispatcherId: "dispatcher-test",
      now: new Date("2026-05-24T08:15:20.000Z"),
      staleAfterMs: 60_000,
    });

    expect(status).toMatchObject({
      state: "fresh",
      dispatcherId: "dispatcher-test",
      pid: 4242,
      hostId: "host-a",
      version: "0.1.4",
      buildHash: "abc123",
    });
  });

  it("distinguishes stale and missing dispatcher heartbeats", async () => {
    await recordDispatcherHeartbeat(sql, {
      dispatcherId: "stale-dispatcher",
      pid: 4242,
      hostId: "host-a",
      now: new Date("2026-05-24T08:00:00.000Z"),
    });

    await expect(loadDispatcherHeartbeatStatus(sql, {
      dispatcherId: "stale-dispatcher",
      now: new Date("2026-05-24T08:05:01.000Z"),
      staleAfterMs: 300_000,
    })).resolves.toMatchObject({ state: "stale" });

    await expect(loadDispatcherHeartbeatStatus(sql, {
      dispatcherId: "missing-dispatcher",
      now: new Date("2026-05-24T08:05:01.000Z"),
      staleAfterMs: 300_000,
    })).resolves.toMatchObject({ state: "missing" });
  });
});
