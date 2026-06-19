import { describe, expect, it } from "vitest";
import type { ModelCapabilityAxis, ModelCapabilityScoreView } from "@/model-catalog/capability-scores";
import { normalizeModelRoutingPolicy } from "./policy";
import {
  AUTO_MODEL_ROUTE,
  resolveConfiguredModelRoute,
  type ModelRoutingPolicy,
} from "./selector";

function capability(
  axis: ModelCapabilityAxis,
  score: number,
  confidence: ModelCapabilityScoreView["confidence"] = "high",
  source = "test",
  updatedAt: Date | null = null,
): ModelCapabilityScoreView {
  return {
    modelCatalogId: null,
    provider: "test",
    adapterType: "test",
    modelId: "test/model",
    canonicalModelId: "test/model",
    axis,
    score,
    rawScore: null,
    source,
    sourceUrl: "https://example.test",
    benchmarkName: `${source}-benchmark`,
    modelVersionMatched: "test/model",
    confidence,
    updatedAt,
  };
}

describe("normalizeModelRoutingPolicy", () => {
  it("normalizes costQualityBalance and strips legacy routing preference knobs", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: {
        costQualityBalance: 120,
        minimumQualityScore: 70,
        qualityWeight: 1,
        costWeight: 5,
        localBonus: 3,
      },
      routeOverrides: {
        "openai:codex:openai-codex/gpt-5.5": {
          enabled: false,
          roleSlugs: ["dev-agent", "qa"],
          adapterType: "ollama",
          status: "healthy",
          qualityScore: 100,
        },
      },
    });

    expect(policy?.preferences).toEqual({ costQualityBalance: 100 });
    expect(policy?.routeOverrides).toEqual({
      "openai:codex:openai-codex/gpt-5.5": {
        enabled: false,
        roleSlugs: ["dev-agent", "qa"],
      },
    });
  });

  it("derives costQualityBalance from legacy quality and cost weights", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: {
        qualityWeight: 1,
        costWeight: 5,
        minimumQualityScore: 70,
        localBonus: 9,
      },
    });

    expect(policy?.preferences).toEqual({ costQualityBalance: 17 });
  });

  it("defaults invalid routing priority preferences to balanced", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: {
        costQualityBalance: "not-a-number",
        qualityWeight: 1,
        costWeight: 5,
      },
    });

    expect(policy?.preferences).toEqual({ costQualityBalance: 50 });
  });

  it("does not normalize null candidate scores to zero", () => {
    const policy = normalizeModelRoutingPolicy({
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          qualityScore: null,
          costScore: null,
        },
      ],
    });

    expect(policy?.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
    });
    expect(policy?.candidates[0]?.qualityScore).toBeUndefined();
    expect(policy?.candidates[0]?.costScore).toBeUndefined();
  });

  it("strips the retired G1 Gemini route family from legacy candidate arrays and role allowlists", () => {
    const policy = normalizeModelRoutingPolicy({
      candidates: [
        {
          adapterType: "gemini",
          model: "google/gemini-2.5-flash",
          enabled: false,
        },
        {
          adapterType: "gemini",
          model: "google/gemini-3.1-flash-lite",
          enabled: true,
        },
      ],
      roleRoutes: {
        "writer-agent": {
          candidateModels: [
            "google/gemini-2.5-flash",
            "google/gemini-3.1-flash-lite",
          ],
        },
      },
    });

    expect(policy?.candidates).toEqual([
      expect.objectContaining({
        adapterType: "gemini",
        model: "google/gemini-3.1-flash-lite",
        enabled: true,
      }),
    ]);
    expect(policy?.roleRoutes).toEqual({
      "writer-agent": {
        candidateModels: ["google/gemini-3.1-flash-lite"],
      },
    });
  });
});

describe("resolveConfiguredModelRoute", () => {
  it("keeps manual adapter and model selections unchanged", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: "codex",
      manualModel: "openai-codex/gpt-5.5",
      policy: {
        candidates: [
          {
            adapterType: "ollama",
            model: "ollama/qwen3:32b",
            qualityScore: 80,
            costScore: 0,
          },
        ],
      },
    });

    expect(route).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      source: "manual_role",
    });
  });

  it("selects the cheapest enabled candidate for cost-biased auto roles", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 17 },
      candidates: [
        {
          adapterType: "claude-code",
          model: "anthropic/claude-opus-4-7",
          qualityScore: 96,
          costScore: 40,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 76,
          costScore: 0,
          local: true,
        },
        {
          adapterType: "ollama",
          model: "ollama/gemma4:26b",
          qualityScore: 60,
          costScore: 0,
          local: true,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
    expect(route.reason).toContain("selected by auto policy");
  });

  it("uses cost-side routing priority to prefer materially cheaper candidates", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 10 },
      candidates: [
        {
          adapterType: "claude-code",
          model: "anthropic/claude-opus-4-7",
          qualityScore: 96,
          costScore: 90,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 76,
          costScore: 0,
          local: true,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
    expect(route.reason).toContain("routing priority 10/100 toward Cost");
    expect(route.reason).not.toContain("quality>=");
  });

  it("uses quality-side routing priority to prefer stronger candidates", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 90 },
      candidates: [
        {
          adapterType: "claude-code",
          model: "anthropic/claude-opus-4-7",
          qualityScore: 96,
          costScore: 40,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 76,
          costScore: 0,
          local: true,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-opus-4-7",
      source: "auto_policy",
    });
    expect(route.reason).toContain("routing priority 90/100 toward Quality");
    expect(route.reason).not.toContain("quality>=");
  });

  it("ignores cost completely when routing priority is pure quality", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 100 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          qualityScore: 97,
          costScore: 100,
        },
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.4",
          qualityScore: 95,
          costScore: 0,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      source: "auto_policy",
    });
    expect(route.reason).toContain("100/100 Pure Quality");
  });

  it("surfaces selected capability provenance and source disagreement", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 90 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.4",
          costScore: 20,
          capabilityScores: [
            capability("coding", 90, "medium", "BenchLM"),
            capability("coding", 45, "medium", "LLM Stats"),
            capability("reasoning", 80, "high", "BenchLM"),
            capability("tool_use", 70, "high", "BenchLM"),
          ],
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Fix TypeScript test",
        taskBrief: "Implement code and run tests",
      },
    });

    const selected = route.scoreBreakdown?.candidates.find((candidate) => candidate.selected);
    expect(selected?.selectedSources.some((source) => source.axis === "coding" && source.source === "BenchLM")).toBe(true);
    expect(selected?.sourceDisagreements.some((item) => item.includes("coding"))).toBe(true);
  });

  it("prefers benchmark source reliability before refresh timestamp when sources tie on confidence", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 100 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.4",
          costScore: 80,
          capabilityScores: [
            capability("coding", 91, "high", "LLM Stats", new Date("2026-01-02T00:00:00Z")),
            capability("coding", 89, "high", "BenchLM", new Date("2026-01-01T00:00:00Z")),
            capability("reasoning", 80, "high", "BenchLM"),
            capability("tool_use", 75, "high", "BenchLM"),
          ],
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Fix failing TypeScript test",
        taskBrief: "Implement code and run tests",
      },
    });

    const selected = route.scoreBreakdown?.candidates.find((candidate) => candidate.selected);
    expect(selected?.selectedSources.find((source) => source.axis === "coding")).toMatchObject({
      source: "BenchLM",
      score: 89,
    });
  });

  it("uses bounded routing scores, not raw throughput, for speed source disagreement", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 75 },
      candidates: [
        {
          adapterType: "local",
          model: "ollama/qwen3:32b",
          costScore: 1,
          capabilityScores: [
            capability("speed", 220, "high", "LLM Stats"),
            capability("speed", 260, "high", "BenchLM"),
            capability("writing", 82, "high", "BenchLM"),
            capability("long_context", 82, "high", "BenchLM"),
            capability("reasoning", 82, "high", "BenchLM"),
            capability("overall_quality", 80, "high", "BenchLM"),
          ],
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "summarizer",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Summarize meeting notes",
        taskBrief: "Create a short summary",
      },
    });

    const selected = route.scoreBreakdown?.candidates.find((candidate) => candidate.selected);
    expect(selected?.sourceDisagreements.some((item) => item.startsWith("speed:"))).toBe(false);
  });

  it("uses internal outcome feedback for the classified task profile", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 70 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          qualityScore: 95,
          costScore: 30,
          outcomeScores: {
            coding: { score: 0.42, sampleSize: 12 },
          },
        },
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.4",
          qualityScore: 88,
          costScore: 30,
          outcomeScores: {
            coding: { score: 0.94, sampleSize: 12 },
          },
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Fix the failing checkout test",
        taskBrief: "Implement the bug fix in TypeScript and add coverage.",
      },
    });

    expect(route).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.4",
      source: "auto_policy",
    });
    expect(route.explanation).toContain("internal outcome feedback");
    expect(route.scoreBreakdown?.candidates.find((candidate) => candidate.selected)?.outcomeScore).toBe(0.94);
  });

  it("does not filter candidates by minimum quality from legacy policies", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: {
        minimumQualityScore: 90,
        qualityWeight: 1,
        costWeight: 9,
      },
      candidates: [
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 80,
          costScore: 0,
        },
      ],
    });

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
  });

  it("does not apply local bonus from legacy policies", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: {
        costQualityBalance: 50,
        localBonus: 1000,
      },
      candidates: [
        {
          adapterType: "claude-code",
          model: "anthropic/claude-sonnet-4-6",
          qualityScore: 90,
          costScore: 10,
          local: false,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 80,
          costScore: 10,
          local: true,
        },
      ],
    });

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      source: "auto_policy",
    });
    expect(route.reason).toContain("routing priority 50/100 Balanced");
  });

  it("routes normalized legacy policy using derived costQualityBalance", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: {
        qualityWeight: 1,
        costWeight: 5,
      },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          qualityScore: 100,
          costScore: 10,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 80,
          costScore: 0,
        },
      ],
    });

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
  });

  it("uses role-specific candidate allowlists when configured", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 50 },
      roleRoutes: {
        "code-review": {
          candidateModels: ["anthropic/claude-sonnet-4-6"],
        },
      },
      candidates: [
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 75,
          costScore: 0,
        },
        {
          adapterType: "claude-code",
          model: "anthropic/claude-sonnet-4-6",
          qualityScore: 82,
          costScore: 30,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "code-review",
      roleType: "system",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "claude-code",
      model: "anthropic/claude-sonnet-4-6",
      source: "auto_policy",
    });
  });

  it("keeps a manual adapter constraint when only the model is automatic", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: "codex",
      manualModel: AUTO_MODEL_ROUTE,
      policy: {
        preferences: { costQualityBalance: 9 },
        candidates: [
          {
            adapterType: "ollama",
            model: "ollama/qwen3:32b",
            qualityScore: 80,
            costScore: 0,
          },
          {
            adapterType: "codex",
            model: "openai-codex/gpt-5.5",
            qualityScore: 95,
            costScore: 20,
          },
        ],
      },
    });

    expect(route).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      source: "auto_policy",
    });
  });

  it("infers the adapter when the model is manual and adapter is automatic", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: "ollama/qwen3:32b",
      policy: {
        candidates: [
          {
            adapterType: "ollama",
            model: "ollama/qwen3:32b",
            qualityScore: 80,
            costScore: 0,
          },
          {
            adapterType: "codex",
            model: "openai-codex/gpt-5.5",
            qualityScore: 95,
            costScore: 20,
          },
        ],
      },
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
  });

  it("returns a blocked route when auto has no eligible candidates", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "doctor",
      roleType: "system",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy: {
        candidates: [
          {
            adapterType: "ollama",
            model: "ollama/gemma4:26b",
            enabled: false,
            qualityScore: 50,
            costScore: 0,
          },
        ],
      },
    });

    expect(route).toMatchObject({
      adapterType: null,
      model: null,
      source: "auto_unavailable",
    });
    expect(route.reason).toContain("no enabled candidates");
  });

  it("blocks unknown, unhealthy, and stale registry-derived candidates", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 50 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          status: "unknown",
          qualityScore: 99,
          costScore: 1,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          status: "unhealthy",
          qualityScore: 99,
          costScore: 0,
        },
        {
          adapterType: "claude-code",
          model: "anthropic/claude-sonnet-4-6",
          status: "healthy",
          probeFreshness: "due",
          qualityScore: 99,
          costScore: 5,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route.source).toBe("auto_unavailable");
  });

  it("treats missing quality conservatively", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 17 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          status: "healthy",
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          status: "healthy",
          qualityScore: 75,
          costScore: 0,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
  });

  it("treats missing cost conservatively when scoring eligible candidates", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 50 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          status: "healthy",
          qualityScore: 100,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          status: "healthy",
          qualityScore: 80,
          costScore: 0,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
  });

  it("treats null cost from normalized policy as expensive, not free", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: { costQualityBalance: 50 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          status: "healthy",
          qualityScore: 100,
          costScore: null,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          status: "healthy",
          qualityScore: 80,
          costScore: 0,
        },
      ],
    });

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
  });

  it("treats null quality from normalized policy as missing and low scoring", () => {
    const policy = normalizeModelRoutingPolicy({
      preferences: { costQualityBalance: 50 },
      candidates: [
        {
          adapterType: "codex",
          model: "openai-codex/gpt-5.5",
          status: "healthy",
          qualityScore: null,
          costScore: 0,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          status: "healthy",
          qualityScore: 75,
          costScore: 50,
        },
      ],
    });

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
    });
  });

  it("chooses a coding-strong model for coding tasks over a generally expensive model", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 91 },
      candidates: [
        {
          adapterType: "premium",
          model: "premium/generalist",
          qualityScore: 98,
          costScore: 90,
          capabilityScores: [
            capability("overall_quality", 98),
            capability("reasoning", 82),
            capability("coding", 55),
            capability("tool_use", 65),
            capability("speed", 55),
          ],
        },
        {
          adapterType: "codex",
          model: "codex/code-specialist",
          qualityScore: 88,
          costScore: 40,
          capabilityScores: [
            capability("overall_quality", 86),
            capability("reasoning", 88),
            capability("coding", 96),
            capability("tool_use", 80),
            capability("speed", 70),
          ],
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Implement a TypeScript bug fix",
        taskBrief: "Write code and tests for the selector.",
      },
    });

    expect(route).toMatchObject({
      adapterType: "codex",
      model: "codex/code-specialist",
      source: "auto_policy",
      profile: "coding",
    });
    expect(route.explanation).toContain("coding");
    expect(route.scoreBreakdown?.selectedScore).toBeGreaterThan(0);
  });

  it("chooses the cheaper writing model when capability fit is close and cost still matters", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 90 },
      candidates: [
        {
          adapterType: "premium",
          model: "premium/writer",
          qualityScore: 94,
          costScore: 20,
          capabilityScores: [
            capability("writing", 94),
            capability("reasoning", 75),
            capability("overall_quality", 83),
          ],
        },
        {
          adapterType: "budget",
          model: "budget/cheap-writer",
          qualityScore: 90,
          costScore: 5,
          capabilityScores: [
            capability("writing", 90),
            capability("reasoning", 74),
            capability("overall_quality", 81),
          ],
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "writer",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Draft documentation",
        taskBrief: "Write a concise article for the release notes.",
      },
    });

    expect(route).toMatchObject({
      adapterType: "budget",
      model: "budget/cheap-writer",
      source: "auto_policy",
      profile: "writing",
    });
    expect(route.reason).toContain("90/100 toward Quality");
  });

  it("does not choose a cheaper close-score candidate with much lower capability fit", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 100 },
      candidates: [
        {
          adapterType: "premium",
          model: "premium/strong-writer",
          qualityScore: 96,
          costScore: 50,
          capabilityScores: [
            capability("writing", 95),
            capability("reasoning", 95),
            capability("overall_quality", 95),
          ],
        },
        {
          adapterType: "budget",
          model: "budget/weak-writer",
          qualityScore: 90,
          costScore: 10,
          capabilityScores: [
            capability("writing", 86),
            capability("reasoning", 86),
            capability("overall_quality", 86),
          ],
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "writer",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Draft documentation",
      },
    });

    expect(route).toMatchObject({
      adapterType: "premium",
      model: "premium/strong-writer",
      source: "auto_policy",
      profile: "writing",
    });
    const strong = route.scoreBreakdown?.candidates.find(
      (candidate) => candidate.model === "premium/strong-writer",
    );
    const weak = route.scoreBreakdown?.candidates.find(
      (candidate) => candidate.model === "budget/weak-writer",
    );
    expect((strong?.capabilityFit ?? 0) - (weak?.capabilityFit ?? 0)).toBeGreaterThan(5);
  });

  it("uses slider-derived quality and cost weights when candidates have no capability scores", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 17 },
      candidates: [
        {
          adapterType: "premium",
          model: "premium/generalist",
          qualityScore: 96,
          costScore: 90,
        },
        {
          adapterType: "ollama",
          model: "ollama/qwen3:32b",
          qualityScore: 76,
          costScore: 0,
          local: true,
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Implement code changes",
      },
    });

    expect(route).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      source: "auto_policy",
      profile: "coding",
    });
  });

  it("penalizes missing and low-confidence capability axes", () => {
    const policy: ModelRoutingPolicy = {
      preferences: { costQualityBalance: 100 },
      candidates: [
        {
          adapterType: "partial",
          model: "partial/coder",
          qualityScore: 92,
          costScore: 0,
          capabilityScores: [
            capability("coding", 96, "low"),
            capability("reasoning", 95),
          ],
        },
        {
          adapterType: "complete",
          model: "complete/coder",
          qualityScore: 86,
          costScore: 0,
          capabilityScores: [
            capability("coding", 88),
            capability("reasoning", 85),
            capability("tool_use", 80),
            capability("speed", 70),
          ],
        },
      ],
    };

    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy,
      taskContext: {
        taskTitle: "Fix TypeScript tests",
      },
    });

    expect(route).toMatchObject({
      adapterType: "complete",
      model: "complete/coder",
      source: "auto_policy",
    });
    const partial = route.scoreBreakdown?.candidates.find(
      (candidate) => candidate.model === "partial/coder",
    );
    expect(partial?.missingAxes).toContain("tool_use");
    expect(partial?.lowConfidenceAxes).toContain("coding");
    expect(partial?.score).toBeLessThan(route.scoreBreakdown?.selectedScore ?? 0);
  });

  it("does not fail models with strong relevant axes when optional axes are missing", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy: {
        preferences: { costQualityBalance: 100 },
        candidates: [
          {
            adapterType: "codex",
            model: "codex/relevant-coder",
            qualityScore: 90,
            costScore: 20,
            capabilityScores: [
              capability("coding", 80),
            ],
          },
        ],
      },
      taskContext: {
        taskTitle: "Implement a TypeScript fix",
      },
    });

    expect(route).toMatchObject({
      adapterType: "codex",
      model: "codex/relevant-coder",
      source: "auto_policy",
      profile: "coding",
    });
    expect(route.scoreBreakdown?.candidates[0]?.missingAxes).toEqual(
      expect.arrayContaining(["reasoning", "tool_use", "speed"]),
    );
  });

  it("does not treat sparse capability data as a perfect profile fit", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "dev-agent",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy: {
        preferences: { costQualityBalance: 100 },
        candidates: [
          {
            adapterType: "fast",
            model: "fast/sparse",
            qualityScore: 90,
            costScore: 0,
            capabilityScores: [
              capability("speed", 100),
            ],
          },
        ],
      },
      taskContext: {
        taskTitle: "Implement a TypeScript fix",
      },
    });

    expect(route).toMatchObject({
      adapterType: null,
      model: null,
      source: "auto_unavailable",
    });
    expect(route.reason).toContain("profile capability");
  });

  it("selects a strong reasoning model for domain-sensitive tasks without every domain axis", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "analyst",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy: {
        preferences: { costQualityBalance: 100 },
        candidates: [
          {
            adapterType: "premium",
            model: "premium/reasoning-domain",
            qualityScore: 94,
            costScore: 40,
            capabilityScores: [
              capability("reasoning", 88),
              capability("overall_quality", 86),
            ],
          },
        ],
      },
      taskContext: {
        taskTitle: "Review a legal compliance summary",
      },
    });

    expect(route).toMatchObject({
      adapterType: "premium",
      model: "premium/reasoning-domain",
      source: "auto_policy",
      profile: "domain_sensitive",
    });
    expect(route.scoreBreakdown?.candidates[0]?.missingAxes).toEqual(
      expect.arrayContaining(["finance", "legal", "health_medical"]),
    );
  });

  it("mentions profile capability filtering when auto candidates miss profile minimums", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "qa",
      roleType: "system",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy: {
        preferences: { costQualityBalance: 100 },
        candidates: [
          {
            adapterType: "small",
            model: "small/weak-analysis",
            qualityScore: 80,
            costScore: 0,
            capabilityScores: [
              capability("reasoning", 20),
              capability("overall_quality", 20),
            ],
          },
        ],
      },
      taskContext: {
        taskTitle: "Analyze production risk",
      },
    });

    expect(route).toMatchObject({
      adapterType: null,
      model: null,
      source: "auto_unavailable",
    });
    expect(route.reason).toContain("profile capability");
  });

  it("marks the selected score-breakdown candidate", () => {
    const route = resolveConfiguredModelRoute({
      roleSlug: "writer",
      roleType: "executor",
      manualAdapterType: AUTO_MODEL_ROUTE,
      manualModel: AUTO_MODEL_ROUTE,
      policy: {
        preferences: { costQualityBalance: 100 },
        candidates: [
          {
            adapterType: "premium",
            model: "premium/writer",
            qualityScore: 90,
            costScore: 20,
            capabilityScores: [
              capability("writing", 90),
              capability("reasoning", 80),
              capability("overall_quality", 80),
            ],
          },
          {
            adapterType: "budget",
            model: "budget/writer",
            qualityScore: 80,
            costScore: 0,
            capabilityScores: [
              capability("writing", 70),
              capability("reasoning", 70),
              capability("overall_quality", 70),
            ],
          },
        ],
      },
      taskContext: {
        taskTitle: "Draft documentation",
      },
    });

    expect(route.scoreBreakdown?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: route.model,
          selected: true,
        }),
      ]),
    );
    expect(route.scoreBreakdown?.candidates.filter((candidate) => candidate.selected)).toHaveLength(1);
  });
});
