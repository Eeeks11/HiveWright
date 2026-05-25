import { createHash } from "node:crypto";

export const SCHEDULE_REVISION_SNAPSHOT_SCHEMA_VERSION = "schedule-revision-snapshot/v1";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ScheduleRevisionSnapshotInput {
  id: string;
  hive_id: string;
  cron_expression: string;
  task_template: unknown;
  enabled: boolean;
  origin_type?: string | null;
  origin_key?: string | null;
  last_run_at?: Date | string | null;
  next_run_at?: Date | string | null;
  created_by: string;
  created_at?: Date | string | null;
}

export interface ScheduleRevisionSnapshotV1 {
  schemaVersion: typeof SCHEDULE_REVISION_SNAPSHOT_SCHEMA_VERSION;
  scheduleId: string;
  hiveId: string;
  cronExpression: string;
  taskTemplate: JsonValue;
  enabled: boolean;
  origin: {
    type: string;
    key: string | null;
  };
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdBy: string;
  scheduleCreatedAt: string | null;
  extension: {
    roleRevision: null;
    skillRevisions: JsonValue[];
  };
  hash: string;
}

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (typeof value === "object") {
    const normalized: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        normalized[key] = normalizeJson(item);
      }
    }
    return normalized;
  }
  return String(value);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function hashScheduleRevisionSnapshot(
  snapshot: Omit<ScheduleRevisionSnapshotV1, "hash"> | ScheduleRevisionSnapshotV1,
): string {
  const payload = { ...(snapshot as ScheduleRevisionSnapshotV1) };
  delete (payload as Partial<ScheduleRevisionSnapshotV1>).hash;
  return `sha256:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
}

export function createScheduleRevisionSnapshot(
  schedule: ScheduleRevisionSnapshotInput,
): ScheduleRevisionSnapshotV1 {
  const payload: Omit<ScheduleRevisionSnapshotV1, "hash"> = {
    schemaVersion: SCHEDULE_REVISION_SNAPSHOT_SCHEMA_VERSION,
    scheduleId: schedule.id,
    hiveId: schedule.hive_id,
    cronExpression: schedule.cron_expression,
    taskTemplate: normalizeJson(schedule.task_template),
    enabled: schedule.enabled,
    origin: {
      type: schedule.origin_type ?? "custom",
      key: schedule.origin_key ?? null,
    },
    lastRunAt: normalizeDate(schedule.last_run_at),
    nextRunAt: normalizeDate(schedule.next_run_at),
    createdBy: schedule.created_by,
    scheduleCreatedAt: normalizeDate(schedule.created_at),
    extension: {
      roleRevision: null,
      skillRevisions: [],
    },
  };

  return {
    ...payload,
    hash: hashScheduleRevisionSnapshot(payload),
  };
}
