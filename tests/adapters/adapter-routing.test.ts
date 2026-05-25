import { describe, expect, it, vi } from "vitest";
import { assertSupportedRuntimeAdapter, UnsupportedAdapterError } from "@/adapters/adapter-routing";
import { defaultAdapterFactory } from "@/model-health/probe-runner";

describe("adapter routing fail-closed behavior", () => {
  it("normalizes supported adapter types", () => {
    expect(assertSupportedRuntimeAdapter(" Codex ")).toBe("codex");
    expect(assertSupportedRuntimeAdapter("CLAUDE-CODE")).toBe("claude-code");
    expect(assertSupportedRuntimeAdapter("ollama")).toBe("ollama");
    expect(assertSupportedRuntimeAdapter("gemini")).toBe("gemini");
    expect(assertSupportedRuntimeAdapter("openai-image")).toBe("openai-image");
  });

  it("rejects unknown adapters instead of defaulting to Claude Code", () => {
    expect(() => assertSupportedRuntimeAdapter("mystery-adapter")).toThrow(UnsupportedAdapterError);
    expect(() => assertSupportedRuntimeAdapter("mystery-adapter")).toThrow(/Unsupported adapter type/);
    expect(() => assertSupportedRuntimeAdapter("mystery-adapter")).toThrow(/codex/);
  });

  it("blocks OpenClaw as a retired dispatch/probe adapter", () => {
    expect(() => assertSupportedRuntimeAdapter("openclaw")).toThrow(/OpenClaw is retired/);
    expect(() => assertSupportedRuntimeAdapter(" openclaw ")).toThrow(/use codex or claude-code/i);
  });

  it("model-health default factory also fails closed before probing", async () => {
    await expect(defaultAdapterFactory("openclaw", vi.fn() as never)).rejects.toThrow(/OpenClaw is retired/);
    await expect(defaultAdapterFactory("not-real", vi.fn() as never)).rejects.toThrow(/Unsupported adapter type/);
  });
});
