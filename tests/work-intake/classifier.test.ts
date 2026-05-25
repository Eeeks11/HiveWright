import { describe, it, expect, vi } from "vitest";
import { classifyWork } from "@/work-intake/classifier";
import type { ChatProvider, ChatResponse } from "@/llm/types";

function mockProvider(id: "ollama" | "openrouter", responder: () => Promise<ChatResponse>): ChatProvider {
  return { id, chat: vi.fn(responder) };
}

const VALID_ROLES = ["dev-agent", "data-analyst", "system-health-auditor"];

describe("classifyWork", () => {
  it("returns a task result when primary succeeds with valid JSON", async () => {
    const primary = mockProvider("ollama", async () => ({
      text: '{"type":"task","role":"dev-agent","confidence":0.9,"reasoning":"clear dev task"}',
      tokensIn: 100, tokensOut: 20, model: "qwen3:32b", provider: "ollama",
    }));
    const fallback = mockProvider("openrouter", async () => {
      throw new Error("should not be called");
    });

    const outcome = await classifyWork("Fix a typo", {
      primary, fallback,
      primaryModel: "qwen3:32b", fallbackModel: "m",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: ["- dev-agent (engineering): builds stuff"],
    });

    expect(outcome.result).toEqual({
      type: "task", role: "dev-agent", confidence: 0.9, reasoning: "clear dev task",
    });
    expect(outcome.providerUsed).toBe("ollama");
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0].success).toBe(true);
  });

  it("falls back when primary throws", async () => {
    const primary = mockProvider("ollama", async () => {
      throw new Error("network down");
    });
    const fallback = mockProvider("openrouter", async () => ({
      text: '{"type":"goal","confidence":0.8,"reasoning":"broad scope"}',
      tokensIn: 80, tokensOut: 10, model: "google/gemini-2.0-flash-exp:free", provider: "openrouter",
    }));

    const outcome = await classifyWork("Launch a new product line", {
      primary, fallback,
      primaryModel: "qwen3:32b", fallbackModel: "google/gemini-2.0-flash-exp:free",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });

    expect(outcome.result?.type).toBe("goal");
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.providerUsed).toBe("openrouter");
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0].success).toBe(false);
    expect(outcome.attempts[0].errorReason).toContain("network down");
    expect(outcome.attempts[1].success).toBe(true);
  });

  it("returns null when both providers fail", async () => {
    const primary = mockProvider("ollama", async () => { throw new Error("primary boom"); });
    const fallback = mockProvider("openrouter", async () => { throw new Error("fallback boom"); });

    const outcome = await classifyWork("something", {
      primary, fallback,
      primaryModel: "qwen3:32b", fallbackModel: "m",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });

    expect(outcome.result).toBeNull();
    expect(outcome.providerUsed).toBe("default-goal-fallback");
    expect(outcome.attempts).toHaveLength(2);
  });

  it("treats malformed JSON as failure, tries fallback", async () => {
    const primary = mockProvider("ollama", async () => ({
      text: "not json at all",
      tokensIn: 5, tokensOut: 5, model: "qwen3:32b", provider: "ollama",
    }));
    const fallback = mockProvider("openrouter", async () => ({
      text: '{"type":"goal","confidence":0.9,"reasoning":"ok"}',
      tokensIn: 5, tokensOut: 5, model: "m", provider: "openrouter",
    }));

    const outcome = await classifyWork("x", {
      primary, fallback,
      primaryModel: "qwen3:32b", fallbackModel: "m",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });

    expect(outcome.result?.type).toBe("goal");
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.attempts[0].success).toBe(false);
    expect(outcome.attempts[0].errorReason).toMatch(/json|parse/i);
  });

  it("returns null when confidence is below threshold", async () => {
    const primary = mockProvider("ollama", async () => ({
      text: '{"type":"task","role":"dev-agent","confidence":0.4,"reasoning":"unsure"}',
      tokensIn: 10, tokensOut: 5, model: "qwen3:32b", provider: "ollama",
    }));
    const fallback = mockProvider("openrouter", async () => ({
      text: '{"type":"task","role":"dev-agent","confidence":0.3,"reasoning":"still unsure"}',
      tokensIn: 10, tokensOut: 5, model: "m", provider: "openrouter",
    }));

    const outcome = await classifyWork("???", {
      primary, fallback,
      primaryModel: "qwen3:32b", fallbackModel: "m",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });

    expect(outcome.result).toBeNull();
    expect(outcome.providerUsed).toBe("default-goal-fallback");
  });

  it("returns null when role is not in the valid role list", async () => {
    const primary = mockProvider("ollama", async () => ({
      text: '{"type":"task","role":"wrong-role","confidence":0.9,"reasoning":"x"}',
      tokensIn: 10, tokensOut: 5, model: "qwen3:32b", provider: "ollama",
    }));
    const fallback = mockProvider("openrouter", async () => ({
      text: '{"type":"task","role":"also-wrong","confidence":0.9,"reasoning":"x"}',
      tokensIn: 10, tokensOut: 5, model: "m", provider: "openrouter",
    }));

    const outcome = await classifyWork("x", {
      primary, fallback,
      primaryModel: "qwen3:32b", fallbackModel: "m",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });

    expect(outcome.result).toBeNull();
    expect(outcome.attempts[0].errorReason).toMatch(/role/i);
    expect(outcome.attempts[1].errorReason).toMatch(/role/i);
  });

  it("returns null immediately when primary is 'none'", async () => {
    const outcome = await classifyWork("anything", {
      primary: null, fallback: null,
      primaryModel: "", fallbackModel: "",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });
    expect(outcome.result).toBeNull();
    expect(outcome.providerUsed).toBe("default-goal-fallback");
    expect(outcome.attempts).toHaveLength(0);
  });

  it("returns fallback result with usedFallback=true when primary is null", async () => {
    const fallback = mockProvider("openrouter", async () => ({
      text: '{"type":"goal","confidence":0.9,"reasoning":"fallback-only config"}',
      tokensIn: 5, tokensOut: 5, model: "m", provider: "openrouter",
    }));
    const outcome = await classifyWork("x", {
      primary: null, fallback,
      primaryModel: "", fallbackModel: "m",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });
    expect(outcome.result?.type).toBe("goal");
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.attempts).toHaveLength(1);
  });

  it("usedFallback=true even when only-configured fallback fails", async () => {
    const fallback = mockProvider("openrouter", async () => {
      throw new Error("fallback down");
    });
    const outcome = await classifyWork("x", {
      primary: null, fallback,
      primaryModel: "", fallbackModel: "m",
      confidenceThreshold: 0.6,
      timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
      validRoles: VALID_ROLES,
      roleLines: [],
    });
    expect(outcome.result).toBeNull();
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0].success).toBe(false);
  });

  it("short-circuits proof-only verification work into a direct task", async () => {
    const outcome = await classifyWork(
      "Verify auth coverage: remaining goal mutation handlers. Audit those handlers and confirm coverage. Produce a concise implementation checklist with exact file paths. Do not modify application code.",
      {
        primary: null, fallback: null,
        primaryModel: "", fallbackModel: "",
        confidenceThreshold: 0.6,
        timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
        validRoles: ["dev-agent", "security-auditor", "system-health-auditor"],
        roleLines: [],
      },
    );

    expect(outcome.result).toEqual({
      type: "task",
      role: "security-auditor",
      confidence: 0.9,
      reasoning: "Proof-only verification/audit work is a single-session task; security/auth keywords route it to security-auditor.",
    });
    expect(outcome.providerUsed).toBe("heuristic-verification");
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.attempts).toHaveLength(0);
  });

  it("does not short-circuit verification work that may still require implementation", async () => {
    const outcome = await classifyWork(
      "Verify codex.ts check() fix is committed and build is clean. If NOT committed: apply the minimal fix in src/provisioning/codex.ts, then commit it and rerun build.",
      {
        primary: null, fallback: null,
        primaryModel: "", fallbackModel: "",
        confidenceThreshold: 0.6,
        timeoutMs: 15000, temperature: 0.1, maxTokens: 512,
        validRoles: VALID_ROLES,
        roleLines: [],
      },
    );

    expect(outcome.result).toBeNull();
    expect(outcome.providerUsed).toBe("default-goal-fallback");
    expect(outcome.attempts).toHaveLength(0);
  });
});
