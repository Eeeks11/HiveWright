import { describe, expect, it } from "vitest";
import {
  createScheduleRevisionSnapshot,
  hashScheduleRevisionSnapshot,
} from "@/schedules/revision-snapshot";

describe("schedule revision snapshots", () => {
  it("creates a deterministic hash independent of object key order", () => {
    const first = createScheduleRevisionSnapshot({
      id: "schedule-1",
      hive_id: "hive-1",
      cron_expression: "0 9 * * *",
      task_template: {
        title: "Daily check",
        brief: "Check the system",
        assignedTo: "dev-agent",
        qaRequired: false,
        priority: 3,
      },
      enabled: true,
      origin_type: "custom",
      origin_key: "daily-check",
      created_by: "owner",
    });

    const second = createScheduleRevisionSnapshot({
      created_by: "owner",
      origin_key: "daily-check",
      origin_type: "custom",
      enabled: true,
      task_template: {
        priority: 3,
        qaRequired: false,
        assignedTo: "dev-agent",
        brief: "Check the system",
        title: "Daily check",
      },
      cron_expression: "0 9 * * *",
      hive_id: "hive-1",
      id: "schedule-1",
    });

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe("schedule-revision-snapshot/v1");
    expect(first.taskTemplate).toEqual({
      assignedTo: "dev-agent",
      brief: "Check the system",
      priority: 3,
      qaRequired: false,
      title: "Daily check",
    });
    expect(first.extension).toEqual({
      roleRevision: null,
      skillRevisions: [],
    });
    expect(first.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.hash).toBe(second.hash);
    expect(hashScheduleRevisionSnapshot(first)).toBe(first.hash);
  });
});
