import { describe, expect, it } from "vitest";
import {
  buildFailureFingerprint,
  groupFailureFingerprints,
} from "@/diagnostics/error-fingerprints";

describe("diagnostic failure fingerprints", () => {
  it("normalizes volatile data and secrets out of repeated failure fingerprints", () => {
    const first = buildFailureFingerprint({
      scope: "provider",
      service: "ollama",
      message: "Timeout after 30000ms for task 8e4aa9f7-c49c-4fb4-9cae-d1811d1aaace using OPENAI_API_KEY=secret",
      topStackFrame: "at OllamaProvider.run (/app/src/adapters/ollama.ts:42:10)",
      affectedTaskId: "task-a",
      checkedAt: new Date("2026-05-24T08:15:00.000Z"),
    });
    const second = buildFailureFingerprint({
      scope: "provider",
      service: "ollama",
      message: "Timeout after 30000ms for task c5f36243-f1ef-4a26-94ba-18cb63f6ec76 using OPENAI_API_KEY=other",
      topStackFrame: "at OllamaProvider.run (/app/src/adapters/ollama.ts:42:10)",
      affectedTaskId: "task-b",
      checkedAt: new Date("2026-05-24T08:45:00.000Z"),
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.normalizedMessage).not.toContain("secret");
    expect(first.normalizedMessage).toContain("[uuid]");
  });

  it("groups matching fingerprints and preserves affected task evidence", () => {
    const fingerprints = [
      buildFailureFingerprint({
        scope: "task",
        message: "Spawn failed: missing credential",
        affectedTaskId: "task-1",
        checkedAt: new Date("2026-05-24T08:15:00.000Z"),
      }),
      buildFailureFingerprint({
        scope: "task",
        message: "Spawn failed: missing credential",
        affectedTaskId: "task-2",
        checkedAt: new Date("2026-05-24T08:16:00.000Z"),
      }),
    ];

    const groups = groupFailureFingerprints(fingerprints);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      count: 2,
      affectedTaskIds: ["task-1", "task-2"],
      firstSeenAt: "2026-05-24T08:15:00.000Z",
      lastSeenAt: "2026-05-24T08:16:00.000Z",
    });
  });
});
