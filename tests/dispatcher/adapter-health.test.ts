import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterProbe } from "@/adapters/types";
import { checkDispatcherModelRouteHealth } from "@/dispatcher/adapter-health";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-1010-4010-8010-aaaaaaaaaaaa";
const NOW = new Date("2026-05-03T01:00:00.000Z");

beforeEach(async () => {
  await truncateAll(sql, { preserveReadOnlyTables: false });
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'dispatcher-health', 'Dispatcher Health', 'digital')
  `;
});

describe("checkDispatcherModelRouteHealth", () => {
  it("allows spawn only when model health and provisioner checks both pass", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES (
        ${fingerprint},
        'openai-codex/gpt-5.5',
        'healthy',
        ${NOW},
        ${new Date(NOW.getTime() + 60 * 60 * 1000)}
      )
    `;

    const decision = await checkDispatcherModelRouteHealth(sql, {
      hiveId: HIVE_ID,
      roleSlug: "dev-agent",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      now: NOW,
      provisionerFor: () => ({
        check: async () => ({ satisfied: true, fixable: false }),
        provision: async function* () {},
      }),
    });

    expect(decision).toMatchObject({
      healthy: true,
      reason: "model_health_and_provisioner_healthy",
    });
  });

  it("blocks before provisioner work when model health evidence is missing", async () => {
    let provisionerChecked = false;

    const decision = await checkDispatcherModelRouteHealth(sql, {
      hiveId: HIVE_ID,
      roleSlug: "dev-agent",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      now: NOW,
      provisionerFor: () => ({
        check: async () => {
          provisionerChecked = true;
          return { satisfied: true, fixable: false };
        },
        provision: async function* () {},
      }),
    });

    expect(decision).toMatchObject({
      healthy: false,
      reason: "model_registry_missing",
    });
    expect(provisionerChecked).toBe(false);
  });

  it("refreshes due model health once before blocking stale routes", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES (
        ${fingerprint},
        'openai-codex/gpt-5.5',
        'healthy',
        ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)},
        ${new Date(NOW.getTime() - 60 * 60 * 1000)}
      )
    `;
    const probe = vi.fn(async () => ({
      healthy: true,
      status: "healthy" as const,
      failureClass: null,
      latencyMs: 25,
      costEstimateUsd: 0,
      reason: {
        code: "probe_ok",
        message: "Probe completed successfully.",
        failureClass: null,
        retryable: false,
      },
    }));

    const decision = await checkDispatcherModelRouteHealth(sql, {
      hiveId: HIVE_ID,
      roleSlug: "dev-agent",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      now: NOW,
      modelHealthAdapterFactory: async () => ({ probe } satisfies AdapterProbe),
      provisionerFor: () => ({
        check: async () => ({ satisfied: true, fixable: false }),
        provision: async function* () {},
      }),
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      healthy: true,
      reason: "model_health_and_provisioner_healthy",
      refresh: {
        attempted: true,
        initialReason: "health_probe_stale",
        outcome: "recovered",
        finalReason: "fresh_healthy_probe",
      },
    });
  });

  it("surfaces refresh failure details when a stale route cannot be re-probed", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES (
        ${fingerprint},
        'openai-codex/gpt-5.5',
        'healthy',
        ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)},
        ${new Date(NOW.getTime() - 60 * 60 * 1000)}
      )
    `;

    const decision = await checkDispatcherModelRouteHealth(sql, {
      hiveId: HIVE_ID,
      roleSlug: "dev-agent",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      now: NOW,
      modelHealthAdapterFactory: async () => {
        throw new Error("probe adapter unavailable");
      },
      provisionerFor: () => ({
        check: async () => ({ satisfied: true, fixable: false }),
        provision: async function* () {},
      }),
    });

    expect(decision).toMatchObject({
      healthy: false,
      reason: "health_probe_stale",
      refresh: {
        attempted: true,
        initialReason: "health_probe_stale",
        outcome: "refresh_failed",
        finalReason: "health_probe_stale",
      },
    });
    expect(decision.detail).toContain("model health refresh failed");
    expect(decision.detail).toContain("probe adapter unavailable");
  });

  it("blocks when the runtime provisioner rejects an otherwise healthy model", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "local",
      adapterType: "ollama",
      baseUrl: null,
    });
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'local', 'qwen3:32b', 'ollama', true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES (
        ${fingerprint},
        'qwen3:32b',
        'healthy',
        ${NOW},
        ${new Date(NOW.getTime() + 60 * 60 * 1000)}
      )
    `;

    const decision = await checkDispatcherModelRouteHealth(sql, {
      hiveId: HIVE_ID,
      roleSlug: "dev-agent",
      adapterType: "ollama",
      modelId: "qwen3:32b",
      now: NOW,
      provisionerFor: () => ({
        check: async () => ({ satisfied: false, fixable: true, reason: "Ollama is offline" }),
        provision: async function* () {},
      }),
    });

    expect(decision).toMatchObject({
      healthy: false,
      reason: "provisioner_unhealthy",
      detail: "Ollama is offline",
    });
  });
});
