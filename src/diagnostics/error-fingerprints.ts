import crypto from "node:crypto";
import { redactDiagnosticText } from "./types";

export type FailureFingerprintInput = {
  scope: "app" | "dispatcher" | "execution_run" | "provider" | "task" | "host_symptom";
  message: string;
  service?: string | null;
  topStackFrame?: string | null;
  affectedHiveId?: string | null;
  affectedGoalId?: string | null;
  affectedTaskId?: string | null;
  checkedAt: Date | string;
};

export type FailureFingerprint = {
  fingerprint: string;
  scope: FailureFingerprintInput["scope"];
  service: string | null;
  normalizedMessage: string;
  topStackFrame: string | null;
  affectedHiveId: string | null;
  affectedGoalId: string | null;
  affectedTaskId: string | null;
  checkedAt: string;
};

export type FailureFingerprintGroup = {
  fingerprint: string;
  scope: FailureFingerprint["scope"];
  service: string | null;
  normalizedMessage: string;
  topStackFrame: string | null;
  count: number;
  affectedHiveIds: string[];
  affectedGoalIds: string[];
  affectedTaskIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
};

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const NUMBER_PATTERN = /\b\d{4,}\b/g;
const PATH_LINE_PATTERN = /:\d+:\d+\)?$/;

export function buildFailureFingerprint(input: FailureFingerprintInput): FailureFingerprint {
  const normalizedMessage = normalizeFailureText(input.message);
  const topStackFrame = input.topStackFrame
    ? redactDiagnosticText(input.topStackFrame).replace(PATH_LINE_PATTERN, "")
    : null;
  const material = [
    input.scope,
    input.service?.trim().toLowerCase() ?? "",
    normalizedMessage,
    topStackFrame ?? "",
  ].join("\n");

  return {
    fingerprint: crypto.createHash("sha256").update(material).digest("hex").slice(0, 32),
    scope: input.scope,
    service: input.service?.trim().toLowerCase() || null,
    normalizedMessage,
    topStackFrame,
    affectedHiveId: input.affectedHiveId ?? null,
    affectedGoalId: input.affectedGoalId ?? null,
    affectedTaskId: input.affectedTaskId ?? null,
    checkedAt: input.checkedAt instanceof Date ? input.checkedAt.toISOString() : input.checkedAt,
  };
}

export function groupFailureFingerprints(
  fingerprints: FailureFingerprint[],
): FailureFingerprintGroup[] {
  const groups = new Map<string, FailureFingerprintGroup>();

  for (const item of fingerprints) {
    const current = groups.get(item.fingerprint);
    if (!current) {
      groups.set(item.fingerprint, {
        fingerprint: item.fingerprint,
        scope: item.scope,
        service: item.service,
        normalizedMessage: item.normalizedMessage,
        topStackFrame: item.topStackFrame,
        count: 1,
        affectedHiveIds: item.affectedHiveId ? [item.affectedHiveId] : [],
        affectedGoalIds: item.affectedGoalId ? [item.affectedGoalId] : [],
        affectedTaskIds: item.affectedTaskId ? [item.affectedTaskId] : [],
        firstSeenAt: item.checkedAt,
        lastSeenAt: item.checkedAt,
      });
      continue;
    }

    current.count += 1;
    addUnique(current.affectedHiveIds, item.affectedHiveId);
    addUnique(current.affectedGoalIds, item.affectedGoalId);
    addUnique(current.affectedTaskIds, item.affectedTaskId);
    if (item.checkedAt < current.firstSeenAt) current.firstSeenAt = item.checkedAt;
    if (item.checkedAt > current.lastSeenAt) current.lastSeenAt = item.checkedAt;
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || a.firstSeenAt.localeCompare(b.firstSeenAt));
}

function normalizeFailureText(text: string): string {
  return redactDiagnosticText(text)
    .replace(UUID_PATTERN, "[uuid]")
    .replace(NUMBER_PATTERN, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function addUnique(values: string[], next: string | null) {
  if (next && !values.includes(next)) values.push(next);
}
