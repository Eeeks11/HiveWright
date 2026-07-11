import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("EA model configuration migration", () => {
  it("backfills active legacy installs without leaking configuration across hives", async () => {
    const hives = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES
        ('ea-migration-explicit', 'Explicit', 'digital'),
        ('ea-migration-default', 'Default', 'digital'),
        ('ea-migration-disabled', 'Disabled', 'digital')
      RETURNING id
    `;
    await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, status)
      VALUES
        (${hives[0].id}, 'ea-discord', 'Discord', ${sql.json({ model: "openai-codex/gpt-5.6" })}, 'active'),
        (${hives[1].id}, 'voice-ea', 'Voice', ${sql.json({})}, 'active'),
        (${hives[2].id}, 'ea-discord', 'Disabled Discord', ${sql.json({ model: "custom/model" })}, 'disabled')
    `;

    const migration = await readFile(
      path.join(process.cwd(), "drizzle/0142_ea_model_configuration.sql"),
      "utf8",
    );
    await sql.unsafe(migration);

    const rows = await sql<{
      hive_id: string;
      primary_model: string | null;
      fallback_model: string | null;
    }[]>`
      SELECT hive_id, primary_model, fallback_model
      FROM ea_model_configurations
      ORDER BY hive_id
    `;

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      {
        hive_id: hives[0].id,
        primary_model: "openai-codex/gpt-5.6-sol",
        fallback_model: "openai-codex/gpt-5.5",
      },
      {
        hive_id: hives[1].id,
        primary_model: "openai-codex/gpt-5.6-sol",
        fallback_model: "openai-codex/gpt-5.5",
      },
    ]));
    expect(rows.some((row) => row.hive_id === hives[2].id)).toBe(false);
  });
});
