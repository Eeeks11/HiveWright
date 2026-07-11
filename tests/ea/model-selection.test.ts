import { beforeEach, describe, expect, it } from "vitest";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import {
  loadGovernedEaModel,
  resolveGovernedEaModel,
} from "@/ea/native/model-selection";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-eeee-4eee-8eee-aaaaaaaaeeee";
const DEFAULT_MODEL = "openai-codex/gpt-5.6";
const RUNTIME_FINGERPRINT = createRuntimeCredentialFingerprint({
  provider: "openai",
  adapterType: "codex",
  baseUrl: null,
});

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'ea-model-selection', 'EA Model Selection', 'digital')
  `;
});

describe("EA model selection", () => {
  it("returns the configured EA model only when its spawn health is fresh and healthy", async () => {
    await sql`
      INSERT INTO connector_installs (
        hive_id,
        connector_slug,
        display_name,
        config,
        status
      )
      VALUES (
        ${HIVE_ID},
        'ea-discord',
        'Discord EA',
        ${sql.json({ model: DEFAULT_MODEL })},
        'active'
      )
    `;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        enabled
      )
      VALUES (
        ${HIVE_ID},
        'openai',
        ${DEFAULT_MODEL},
        'codex',
        true
      )
    `;
    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        last_probed_at,
        next_probe_at
      )
      VALUES (
        ${RUNTIME_FINGERPRINT},
        ${DEFAULT_MODEL},
        'healthy',
        NOW(),
        NOW() + INTERVAL '1 hour'
      )
    `;

    await expect(loadGovernedEaModel(sql, HIVE_ID, ["ea-discord"])).resolves.toBe(DEFAULT_MODEL);
    await expect(resolveGovernedEaModel(sql, HIVE_ID, DEFAULT_MODEL)).resolves.toBe(DEFAULT_MODEL);
  });

  it("falls back to the runtime default when the configured model has no fresh health row", async () => {
    await sql`
      INSERT INTO connector_installs (
        hive_id,
        connector_slug,
        display_name,
        config,
        status
      )
      VALUES (
        ${HIVE_ID},
        'ea-discord',
        'Discord EA',
        ${sql.json({ model: DEFAULT_MODEL })},
        'active'
      )
    `;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        enabled
      )
      VALUES (
        ${HIVE_ID},
        'openai',
        ${DEFAULT_MODEL},
        'codex',
        true
      )
    `;

    await expect(loadGovernedEaModel(sql, HIVE_ID, ["ea-discord"])).resolves.toBeUndefined();
    await expect(resolveGovernedEaModel(sql, HIVE_ID, DEFAULT_MODEL)).resolves.toBeUndefined();
  });
});
