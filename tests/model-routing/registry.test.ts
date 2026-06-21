import { beforeEach, describe, expect, it } from "vitest";
import {
  loadModelRoutingView,
  routeKeyForModel,
} from "@/model-routing/registry";
import { saveModelRoutingPolicy } from "@/model-routing/policy";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "bbbbbbbb-7777-4777-8777-bbbbbbbbbbbb";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'routing-view-hive', 'Routing View Hive', 'digital')
  `;
});

describe("model routing registry view", () => {
  it("builds route keys from provider, adapter, and model", () => {
    expect(routeKeyForModel({
      provider: "openai",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
    })).toBe("openai:codex:openai-codex/gpt-5.5");
  });

  it("derives model rows from configured hive models and health", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });

    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (
        ${HIVE_ID},
        'openai',
        'openai-codex/gpt-5.5',
        'codex',
        96,
        25,
        true
      )
    `;

    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        latency_ms
      )
      VALUES (${fingerprint}, 'openai-codex/gpt-5.5', 'healthy', 1200)
    `;

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      provider: "openai",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      hiveModelEnabled: true,
      routingEnabled: true,
      status: "healthy",
      qualityScore: 96,
      costScore: 25,
      local: false,
      latencyMs: 1200,
    });
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      status: "healthy",
      qualityScore: 96,
      costScore: 25,
    });
  });

  it("collapses provider-prefixed aliases into one routing row", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        fallback_priority,
        enabled
      )
      VALUES
        (${HIVE_ID}, 'openai', 'gpt-5.5', 'codex', 94, 20, 100, true),
        (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, 100, true)
    `;

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      provider: "openai",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      qualityScore: 96,
      costScore: 25,
    });
    expect(view.policy.candidates).toHaveLength(1);
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
    });
  });

  it("applies saved routing overrides without changing registry facts", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${HIVE_ID}, 'local', 'ollama/qwen3:32b', 'ollama', 80, 0, true)
    `;

    await saveModelRoutingPolicy(sql, HIVE_ID, {
      preferences: { costQualityBalance: 17 },
      routeOverrides: {
        "local:ollama:ollama/qwen3:32b": {
          enabled: false,
          roleSlugs: ["dev-agent"],
        },
      },
      candidates: [
        {
          adapterType: "codex",
          model: "unconfigured/free-text",
          status: "healthy",
          qualityScore: 100,
          costScore: 0,
        },
      ],
    });

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "local:ollama:ollama/qwen3:32b",
      routingEnabled: false,
      roleSlugs: ["dev-agent"],
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
    });
    expect(view.policy.candidates).toHaveLength(1);
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      enabled: false,
      roleSlugs: ["dev-agent"],
    });
  });

  it("does not let routing overrides re-enable disabled hive models", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, false)
    `;

    await saveModelRoutingPolicy(sql, HIVE_ID, {
      routeOverrides: {
        "openai:codex:openai-codex/gpt-5.5": {
          enabled: true,
        },
      },
      candidates: [],
    });

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      hiveModelEnabled: false,
      routingEnabled: true,
      roleSlugs: [],
    });
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      enabled: false,
    });
    expect(view.policy.candidates[0].roleSlugs).toBeUndefined();
  });

  it("persists canonical route candidate metadata for configured automatic inventory", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        capabilities,
        enabled
      )
      VALUES
        (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', '[]'::jsonb, true),
        (${HIVE_ID}, 'openai', 'openai-image/gpt-image-1', 'openai-image', '["image"]'::jsonb, true),
        (${HIVE_ID}, 'local', 'ollama/qwen3:32b', 'ollama', '[]'::jsonb, true),
        (${HIVE_ID}, 'anthropic', 'claude-opus', 'anthropic', '[]'::jsonb, false)
    `;

    await saveModelRoutingPolicy(sql, HIVE_ID, {
      routeOverrides: {
        "local:ollama:ollama/qwen3:32b": {
          roleSlugs: ["dev-agent"],
        },
      },
      candidates: [],
    });

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.basePolicyState.policy?.candidates).toHaveLength(4);
    expect(view.basePolicyState.policy?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapterType: "codex",
        model: "openai-codex/gpt-5.5",
        enabled: true,
        canonicalRouteSet: expect.objectContaining({ membership: "included" }),
      }),
      expect.objectContaining({
        adapterType: "openai-image",
        model: "openai-image/gpt-image-1",
        enabled: false,
        canonicalRouteSet: expect.objectContaining({ membership: "excluded" }),
      }),
      expect.objectContaining({
        adapterType: "ollama",
        model: "ollama/qwen3:32b",
        enabled: true,
        roleSlugs: ["dev-agent"],
        canonicalRouteSet: expect.objectContaining({ membership: "role_scoped" }),
      }),
      expect.objectContaining({
        adapterType: "anthropic",
        model: "claude-opus",
        enabled: false,
        canonicalRouteSet: expect.objectContaining({ membership: "intentionally_disabled" }),
      }),
    ]));

    const persisted = await sql<{ config: { candidates?: unknown[] } }[]>`
      SELECT config
      FROM adapter_config
      WHERE hive_id = ${HIVE_ID}
        AND adapter_type = 'model-routing'
      LIMIT 1
    `;
    expect(persisted[0].config.candidates).toHaveLength(4);
    expect(view.policy.candidates.find((candidate) => candidate.model === "openai-codex/gpt-5.5")?.canonicalRouteSet?.routeKey)
      .toBe("openai:codex:openai-codex/gpt-5.5");
  });

  it("excludes OpenAI Codex routes with non-retryable scope failures from the canonical automatic pool", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });
    const scopeBlockedModels = Array.from({ length: 43 }, (_, index) => (
      `openai-codex/of-scope-blocked-${String(index + 1).padStart(2, "0")}`
    ));
    const retainedModel = "openai-codex/gpt-5.5";

    for (const [index, modelId] of [...scopeBlockedModels, retainedModel].entries()) {
      await sql`
        INSERT INTO hive_models (
          hive_id,
          provider,
          model_id,
          adapter_type,
          capabilities,
          fallback_priority,
          enabled
        )
        VALUES (
          ${HIVE_ID},
          'openai',
          ${modelId},
          'codex',
          '["text","code"]'::jsonb,
          ${100 + index},
          true
        )
      `;
    }

    for (const modelId of scopeBlockedModels) {
      await sql`
        INSERT INTO model_health (
          fingerprint,
          model_id,
          status,
          last_failure_reason
        )
        VALUES (
          ${fingerprint},
          ${modelId},
          'unhealthy',
          ${JSON.stringify({ failureClass: "scope", message: "model entitlement denied" })}
        )
      `;
    }
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, latency_ms)
      VALUES (${fingerprint}, ${retainedModel}, 'healthy', 1400)
    `;

    const view = await loadModelRoutingView(sql, HIVE_ID);
    const scopeBlockedCandidates = view.basePolicyState.policy?.candidates.filter((candidate) => (
      scopeBlockedModels.includes(candidate.model)
    ));
    const retainedCandidate = view.basePolicyState.policy?.candidates.find((candidate) => (
      candidate.model === retainedModel
    ));

    expect(scopeBlockedCandidates).toHaveLength(43);
    expect(scopeBlockedCandidates).toEqual(scopeBlockedModels.map((modelId) => expect.objectContaining({
      adapterType: "codex",
      model: modelId,
      enabled: false,
      status: "disabled",
      canonicalRouteSet: expect.objectContaining({
        membership: "excluded",
        routeKey: `openai:codex:${modelId}`,
        reason: expect.stringContaining("scope/model-entitlement failure"),
      }),
    })));
    expect(retainedCandidate).toMatchObject({
      adapterType: "codex",
      model: retainedModel,
      enabled: true,
      canonicalRouteSet: expect.objectContaining({ membership: "included" }),
    });
  });

  it("prunes unsupported legacy Codex routes instead of retaining anonymous excluded inventory", async () => {
    const legacyModel = "openai-codex/gpt-5.3-codex";
    const retainedModel = "openai-codex/gpt-5.4-mini";

    for (const [index, modelId] of [legacyModel, retainedModel].entries()) {
      await sql`
        INSERT INTO hive_models (
          hive_id,
          provider,
          model_id,
          adapter_type,
          capabilities,
          fallback_priority,
          enabled
        )
        VALUES (
          ${HIVE_ID},
          'openai',
          ${modelId},
          'codex',
          '["text","code","reasoning"]'::jsonb,
          ${100 + index},
          true
        )
      `;
    }

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models.map((model) => model.model)).not.toContain(legacyModel);
    expect(view.basePolicyState.policy?.candidates.map((candidate) => candidate.model)).not.toContain(legacyModel);
    expect(view.policy.candidates.map((candidate) => candidate.model)).not.toContain(legacyModel);
    expect(view.policy.candidates.find((candidate) => candidate.model === retainedModel)).toMatchObject({
      adapterType: "codex",
      model: retainedModel,
      enabled: true,
      canonicalRouteSet: expect.objectContaining({ membership: "included" }),
    });
  });

  it("persists an empty canonical policy after pruning the only unsupported legacy Codex route", async () => {
    const legacyModel = "openai-codex/gpt-5.3-codex";

    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        capabilities,
        fallback_priority,
        enabled
      )
      VALUES (
        ${HIVE_ID},
        'openai',
        ${legacyModel},
        'codex',
        '["text","code","reasoning"]'::jsonb,
        100,
        true
      )
    `;

    await saveModelRoutingPolicy(sql, HIVE_ID, {
      preferences: { costQualityBalance: 42 },
      routeOverrides: {
        [`openai:codex:${legacyModel}`]: {
          enabled: true,
          roleSlugs: ["dev-agent"],
        },
      },
      roleRoutes: {
        "dev-agent": {
          candidateModels: [legacyModel],
        },
      },
      candidates: [
        {
          adapterType: "codex",
          model: legacyModel,
          enabled: true,
          status: "healthy",
        },
      ],
    });

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(0);
    expect(view.basePolicyState.source).toBe("hive");
    expect(view.basePolicyState.policy).toMatchObject({
      preferences: { costQualityBalance: 42 },
      routeOverrides: {
        [`openai:codex:${legacyModel}`]: {
          enabled: true,
          roleSlugs: ["dev-agent"],
        },
      },
      roleRoutes: {
        "dev-agent": {
          candidateModels: [legacyModel],
        },
      },
      candidates: [],
    });
    expect(view.policy.candidates).toHaveLength(0);

    const persisted = await sql<{ config: { candidates?: unknown[] } }[]>`
      SELECT config
      FROM adapter_config
      WHERE hive_id = ${HIVE_ID}
        AND adapter_type = 'model-routing'
      LIMIT 1
    `;
    expect(persisted[0].config.candidates).toEqual([]);
  });

  it("retires disabled Anthropic claude-code routes from the canonical automatic pool", async () => {
    const disabledAnthropicModels = Array.from({ length: 17 }, (_, index) => (
      `anthropic/claude-disabled-${String(index + 1).padStart(2, "0")}`
    ));
    const retainedModel = "anthropic/claude-sonnet-4-6";

    for (const [index, modelId] of [...disabledAnthropicModels, retainedModel].entries()) {
      await sql`
        INSERT INTO hive_models (
          hive_id,
          provider,
          model_id,
          adapter_type,
          capabilities,
          fallback_priority,
          enabled
        )
        VALUES (
          ${HIVE_ID},
          'anthropic',
          ${modelId},
          'claude-code',
          '["text","code","reasoning"]'::jsonb,
          ${100 + index},
          ${modelId === retainedModel}
        )
      `;
    }

    const view = await loadModelRoutingView(sql, HIVE_ID);
    const disabledCandidates = view.basePolicyState.policy?.candidates.filter((candidate) => (
      disabledAnthropicModels.includes(candidate.model)
    ));
    const retainedCandidate = view.basePolicyState.policy?.candidates.find((candidate) => (
      candidate.model === retainedModel
    ));

    expect(disabledCandidates).toHaveLength(17);
    expect(disabledCandidates).toEqual(disabledAnthropicModels.map((modelId) => expect.objectContaining({
      adapterType: "claude-code",
      model: modelId,
      enabled: false,
      status: "disabled",
      canonicalRouteSet: expect.objectContaining({
        membership: "excluded",
        routeKey: `anthropic:claude-code:${modelId}`,
        reason: expect.stringContaining("retired from the canonical automatic route pool"),
      }),
    })));
    expect(retainedCandidate).toMatchObject({
      adapterType: "claude-code",
      model: retainedModel,
      enabled: true,
      canonicalRouteSet: expect.objectContaining({ membership: "included" }),
    });
  });

  it("adds recent internal outcome scores to routing candidates by classified task profile", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('dev-agent', 'Dev Agent', 'executor', 'auto')
      ON CONFLICT (slug) DO NOTHING
    `;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.4', 'codex', 88, 25, true)
    `;

    for (let i = 0; i < 3; i++) {
      const [task] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, priority, title, brief,
          model_used, adapter_used, completed_at
        )
        VALUES (
          ${HIVE_ID}, 'dev-agent', 'owner', 'completed', 5,
          ${`Implement routing fix ${i}`}, 'TypeScript implementation and test coverage',
          'openai-codex/gpt-5.4', 'codex', NOW()
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${task.id}, ${HIVE_ID}, 'positive', 'explicit_owner_feedback', 'good output', 1, 9)
      `;
    }

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.4",
      outcomeScores: {
        coding: {
          score: 0.9,
          sampleSize: 3,
        },
      },
    });
  });
});
