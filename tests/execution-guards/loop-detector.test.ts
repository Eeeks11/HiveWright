import { describe, expect, it } from "vitest";
import {
  createRuntimeLoopDetector,
  parseLoopGuardConfig,
} from "@/execution-guards";
import type { AdapterRuntimeEvent } from "@/execution-guards";

function toolCall(toolName: string, args: unknown): AdapterRuntimeEvent {
  return {
    type: "tool_call",
    adapter: "codex",
    toolName,
    args,
    callId: null,
    source: "structured_stream",
    timestamp: new Date("2026-05-19T00:00:00.000Z"),
  };
}

describe("RuntimeLoopDetector", () => {
  it("warns and then interrupts repeated tool calls by stable key", () => {
    const detector = createRuntimeLoopDetector({
      mode: "enforce",
      warnThreshold: 3,
      hardLimit: 5,
      windowSize: 20,
      toolFrequencyWarn: 30,
      toolFrequencyHardLimit: 50,
    });
    const event = toolCall("read_file", { path: "src/app.ts", start_line: 1 });

    expect(detector.observe(event).action).toBe("none");
    expect(detector.observe(event).action).toBe("none");
    expect(detector.observe(event)).toMatchObject({
      action: "warn",
      reason: expect.stringContaining("read_file"),
    });
    expect(detector.observe(event).action).toBe("none");
    expect(detector.observe(event)).toMatchObject({
      action: "interrupt",
      reason: expect.stringContaining("repeated"),
    });
  });

  it("buckets read_file calls by 200-line ranges", () => {
    const detector = createRuntimeLoopDetector({
      mode: "enforce",
      warnThreshold: 2,
      hardLimit: 4,
      windowSize: 20,
      toolFrequencyWarn: 30,
      toolFrequencyHardLimit: 50,
    });

    expect(detector.observe(toolCall("read_file", { path: "a.ts", start_line: 1 })).action).toBe("none");
    expect(detector.observe(toolCall("read_file", { path: "a.ts", start_line: 199 })).action).toBe("warn");
    expect(detector.observe(toolCall("read_file", { path: "a.ts", start_line: 201 })).action).toBe("none");
  });

  it("treats writes as content-sensitive", () => {
    const detector = createRuntimeLoopDetector({
      mode: "enforce",
      warnThreshold: 2,
      hardLimit: 3,
      windowSize: 20,
      toolFrequencyWarn: 30,
      toolFrequencyHardLimit: 50,
    });

    expect(detector.observe(toolCall("write_file", { path: "a.txt", content: "one" })).action).toBe("none");
    expect(detector.observe(toolCall("write_file", { path: "a.txt", content: "two" })).action).toBe("none");
    expect(detector.observe(toolCall("write_file", { path: "a.txt", content: "one" })).action).toBe("warn");
  });

  it("normalizes malformed JSON string args without throwing", () => {
    const detector = createRuntimeLoopDetector({
      mode: "enforce",
      warnThreshold: 2,
      hardLimit: 3,
      windowSize: 20,
      toolFrequencyWarn: 30,
      toolFrequencyHardLimit: 50,
    });

    expect(detector.observe(toolCall("shell", "{not json")).action).toBe("none");
    expect(detector.observe(toolCall("shell", "{not json")).action).toBe("warn");
  });

  it("honors tool frequency warning and hard limits", () => {
    const detector = createRuntimeLoopDetector({
      mode: "enforce",
      warnThreshold: 10,
      hardLimit: 20,
      windowSize: 10,
      toolFrequencyWarn: 3,
      toolFrequencyHardLimit: 4,
    });

    expect(detector.observe(toolCall("grep", { query: "a" })).action).toBe("none");
    expect(detector.observe(toolCall("grep", { query: "b" })).action).toBe("none");
    expect(detector.observe(toolCall("grep", { query: "c" }))).toMatchObject({
      action: "warn",
      reason: expect.stringContaining("frequency"),
    });
    expect(detector.observe(toolCall("grep", { query: "d" }))).toMatchObject({
      action: "interrupt",
      reason: expect.stringContaining("frequency"),
    });
  });

  it("limits repeated warnings until reset", () => {
    const detector = createRuntimeLoopDetector({
      mode: "enforce",
      warnThreshold: 2,
      hardLimit: 10,
      windowSize: 20,
      toolFrequencyWarn: 30,
      toolFrequencyHardLimit: 50,
    });
    const event = toolCall("read_file", { path: "a.ts", start_line: 1 });

    expect(detector.observe(event).action).toBe("none");
    expect(detector.observe(event).action).toBe("warn");
    expect(detector.observe(event).action).toBe("none");
    detector.reset();
    expect(detector.observe(event).action).toBe("none");
    expect(detector.observe(event).action).toBe("warn");
  });
});

describe("parseLoopGuardConfig", () => {
  it("parses env overrides and falls back on invalid numbers", () => {
    expect(parseLoopGuardConfig({
      HIVEWRIGHT_LOOP_GUARD_MODE: "diagnostic",
      HIVEWRIGHT_LOOP_WARN_THRESHOLD: "2",
      HIVEWRIGHT_LOOP_HARD_LIMIT: "bad",
      HIVEWRIGHT_LOOP_WINDOW_SIZE: "7",
      HIVEWRIGHT_LOOP_TOOL_FREQ_WARN: "4",
      HIVEWRIGHT_LOOP_TOOL_FREQ_HARD_LIMIT: "5",
    })).toMatchObject({
      mode: "diagnostic",
      warnThreshold: 2,
      hardLimit: 5,
      windowSize: 7,
      toolFrequencyWarn: 4,
      toolFrequencyHardLimit: 5,
    });
  });
});
