import { beforeEach, describe, expect, it } from "vitest";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import {
  DEFAULT_EA_FALLBACK_MODEL,
  DEFAULT_EA_PRIMARY_MODEL,
  getEaModelConfiguration,
  recordEaModelRouteTelemetry,
  resolveEaModelRoute,
  updateEaModelConfiguration,
} from "@/ea/native/model-selection";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-eeee-4eee-8eee-aaaaaaaaeeee";
const OTHER_HIVE_ID = "bbbbbbbb-eeee-4eee-8eee-bbbbbbbbeeee";
const RUNTIME_FINGERPRINT = createRuntimeCredentialFingerprint({
  provider: "openai",
  adapterType: "codex",
  baseUrl: null,
});

async function registerHealthyModel(hiveId: string, modelId: string): Promise<void> {
  await sql`
    INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
    VALUES (${hiveId}, 'openai', ${modelId}, 'codex', true)
  `;
  await sql`
    INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
    VALUES (${RUNTIME_FINGERPRINT}, ${modelId}, 'healthy', NOW(), NOW() + INTERVAL '1 hour')
    ON CONFLICT (fingerprint, model_id) DO UPDATE SET
      status = 'healthy', last_probed_at = NOW(), next_probe_at = NOW() + INTERVAL '1 hour'
  `;
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_ID}, 'ea-model-selection', 'EA Model Selection', 'digital'),
      (${OTHER_HIVE_ID}, 'ea-model-other', 'Other EA Model', 'digital')
  `;
});

describe("EA model configuration and routing", () => {
  it("preserves null compatibility when no per-hive configuration exists", async () => {
    await expect(getEaModelConfiguration(sql, HIVE_ID)).resolves.toEqual({
      primaryModel: null,
      fallbackModel: null,
    });
    await expect(resolveEaModelRoute(sql, HIVE_ID)).resolves.toMatchObject({
      model: undefined,
      selected: "runtime_default",
      reason: "configuration_missing",
    });
  });

  it("persists a canonical Sol primary and GPT-5.5 fallback per hive", async () => {
    await updateEaModelConfiguration(sql, HIVE_ID, {
      primaryModel: DEFAULT_EA_PRIMARY_MODEL,
      fallbackModel: DEFAULT_EA_FALLBACK_MODEL,
    });

    await expect(getEaModelConfiguration(sql, HIVE_ID)).resolves.toEqual({
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });
    await expect(getEaModelConfiguration(sql, OTHER_HIVE_ID)).resolves.toEqual({
      primaryModel: null,
      fallbackModel: null,
    });
  });

  it("selects healthy Sol primary and falls back to healthy GPT-5.5 when Sol is not routable", async () => {
    await updateEaModelConfiguration(sql, HIVE_ID, {
      primaryModel: DEFAULT_EA_PRIMARY_MODEL,
      fallbackModel: DEFAULT_EA_FALLBACK_MODEL,
    });
    await registerHealthyModel(HIVE_ID, DEFAULT_EA_FALLBACK_MODEL);

    await expect(resolveEaModelRoute(sql, HIVE_ID)).resolves.toMatchObject({
      model: DEFAULT_EA_FALLBACK_MODEL,
      selected: "fallback",
      reason: "primary_model_registry_missing",
    });

    await registerHealthyModel(HIVE_ID, DEFAULT_EA_PRIMARY_MODEL);
    await expect(resolveEaModelRoute(sql, HIVE_ID)).resolves.toMatchObject({
      model: DEFAULT_EA_PRIMARY_MODEL,
      selected: "primary",
      reason: "fresh_healthy_probe",
    });
  });

  it("selects the configured healthy fallback at the voice budget downgrade tier", async () => {
    await updateEaModelConfiguration(sql, HIVE_ID, {
      primaryModel: DEFAULT_EA_PRIMARY_MODEL,
      fallbackModel: DEFAULT_EA_FALLBACK_MODEL,
    });
    await registerHealthyModel(HIVE_ID, DEFAULT_EA_PRIMARY_MODEL);
    await registerHealthyModel(HIVE_ID, DEFAULT_EA_FALLBACK_MODEL);

    await expect(resolveEaModelRoute(sql, HIVE_ID, { preferFallback: true })).resolves.toMatchObject({
      model: DEFAULT_EA_FALLBACK_MODEL,
      selected: "fallback",
      reason: "budget_fallback",
    });
  });

  it("requires enabled, fresh, in-scope and routable health evidence", async () => {
    await updateEaModelConfiguration(sql, HIVE_ID, {
      primaryModel: DEFAULT_EA_PRIMARY_MODEL,
      fallbackModel: null,
    });
    await registerHealthyModel(OTHER_HIVE_ID, DEFAULT_EA_PRIMARY_MODEL);

    await expect(resolveEaModelRoute(sql, HIVE_ID)).resolves.toMatchObject({
      model: undefined,
      selected: "runtime_default",
      reason: "primary_model_registry_missing",
    });

    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'openai', ${DEFAULT_EA_PRIMARY_MODEL}, 'codex', false)
    `;
    await expect(resolveEaModelRoute(sql, HIVE_ID)).resolves.toMatchObject({
      model: undefined,
      reason: "primary_model_registry_disabled",
    });

    await sql`
      UPDATE hive_models
      SET enabled = true
      WHERE hive_id = ${HIVE_ID} AND model_id = ${DEFAULT_EA_PRIMARY_MODEL}
    `;
    await sql`
      UPDATE model_health
      SET last_probed_at = NOW() - INTERVAL '2 days',
          next_probe_at = NOW() - INTERVAL '1 day'
      WHERE fingerprint = ${RUNTIME_FINGERPRINT} AND model_id = ${DEFAULT_EA_PRIMARY_MODEL}
    `;
    await expect(resolveEaModelRoute(sql, HIVE_ID)).resolves.toMatchObject({
      model: undefined,
      reason: "primary_health_probe_stale",
    });

    await sql`
      UPDATE model_health
      SET status = 'unhealthy', last_probed_at = NOW(), next_probe_at = NOW() + INTERVAL '5 minutes'
      WHERE fingerprint = ${RUNTIME_FINGERPRINT} AND model_id = ${DEFAULT_EA_PRIMARY_MODEL}
    `;
    await expect(resolveEaModelRoute(sql, HIVE_ID)).resolves.toMatchObject({
      model: undefined,
      reason: "primary_health_probe_unhealthy",
    });
  });

  it("persists route telemetry with the selected model and hive scope", async () => {
    const route = {
      model: DEFAULT_EA_FALLBACK_MODEL,
      selected: "fallback" as const,
      reason: "budget_fallback",
      primaryModel: DEFAULT_EA_PRIMARY_MODEL,
      fallbackModel: DEFAULT_EA_FALLBACK_MODEL,
    };
    await recordEaModelRouteTelemetry(sql, {
      hiveId: HIVE_ID,
      transport: "voice",
      route,
    });

    const rows = await sql<{
      hive_id: string;
      transport: string;
      selected: string;
      model_id: string | null;
      reason: string;
    }[]>`
      SELECT hive_id, transport, selected, model_id, reason
      FROM ea_model_route_events
    `;
    expect(rows).toEqual([{
      hive_id: HIVE_ID,
      transport: "voice",
      selected: "fallback",
      model_id: DEFAULT_EA_FALLBACK_MODEL,
      reason: "budget_fallback",
    }]);
  });
});
