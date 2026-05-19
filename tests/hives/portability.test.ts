import { describe, expect, it, beforeEach } from "vitest";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";
import {
  exportHiveTemplate,
  importHiveTemplate,
  previewHiveTemplateImport,
  type HivePortablePackage,
} from "@/hives/portability";

async function seedPortableHive() {
  const fixture = createFixtureNamespace("hive-portability");
  const slug = fixture.slug("source-hive");
  const [hive] = await sql<{ id: string; slug: string }[]>`
    INSERT INTO hives (name, slug, type, description, mission, software_stack, workspace_path, ai_budget_cap_cents, ai_budget_window)
    VALUES (
      'Portable Source',
      ${slug},
      'digital',
      'Exportable but not runtime state',
      'Run a portable operation',
      'Next.js, Postgres',
      '/tmp/source-workspace',
      2500,
      'monthly'
    )
    RETURNING id, slug
  `;

  const [credential] = await sql<{ id: string }[]>`
    INSERT INTO credentials (hive_id, name, key, value)
    VALUES (${hive.id}::uuid, 'Discord secret', 'connector:discord-webhook:test', 'encrypted-secret-value')
    RETURNING id
  `;

  await sql`
    INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, granted_scopes, credential_id, status, last_error, last_tested_at)
    VALUES (
      ${hive.id}::uuid,
      'discord-webhook',
      'Owner Discord',
      ${sql.json({ defaultUsername: 'HiveWright', webhookUrl: 'https://public.example/hook' })},
      ${sql.json(['discord-webhook:test_connection', 'discord-webhook:send_message'])},
      ${credential.id}::uuid,
      'active',
      'runtime error should not export',
      NOW()
    )
  `;

  await sql`
    INSERT INTO goals (hive_id, title, description, priority, status, budget_cents, spent_cents, session_id, outcome_classification)
    VALUES
      (${hive.id}::uuid, 'Safe starter goal', 'Imported as starter context', 4, 'active', 500, 123, 'runtime-session', 'outcome-led'),
      (${hive.id}::uuid, 'Done goal excluded', 'Runtime result', 5, 'completed', null, 0, null, null)
  `;

  const [goal] = await sql<{ id: string }[]>`
    SELECT id FROM goals WHERE hive_id = ${hive.id}::uuid AND title = 'Safe starter goal'
  `;

  await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, budget_cents, spent_cents, title, brief, goal_id, qa_required, acceptance_criteria, result_summary, retry_count, model_used)
    VALUES
      (${hive.id}::uuid, 'dev-agent', 'owner', 'pending', 3, 400, 0, 'Starter task', 'Do the safe first step', ${goal.id}::uuid, true, 'Proof exists', null, 0, null),
      (${hive.id}::uuid, 'dev-agent', 'owner', 'completed', 3, 400, 5, 'Runtime task excluded', 'Already ran', ${goal.id}::uuid, false, null, 'done', 1, 'runtime-model')
  `;

  await sql`
    INSERT INTO action_policies (hive_id, name, enabled, connector, operation, effect_type, effect, role_slug, priority, conditions, reason, created_by)
    VALUES
      (${hive.id}::uuid, 'Allow read', true, null, null, 'read', 'allow', null, 100, ${sql.json({})}, 'portable low risk', 'owner'),
      (${hive.id}::uuid, 'Block destructive', true, null, null, 'destructive', 'block', null, 90, ${sql.json({})}, 'portable guardrail', 'owner'),
      (${hive.id}::uuid, 'Allow destructive excluded', true, null, null, 'destructive', 'allow', null, 80, ${sql.json({})}, 'too risky', 'owner')
  `;

  await sql`
    INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, origin_type, origin_key, last_run_at, next_run_at, created_by)
    VALUES (
      ${hive.id}::uuid,
      '0 9 * * *',
      ${sql.json({ assignedTo: 'dev-agent', title: 'Daily safe review', brief: 'Review safely', priority: 4 })},
      true,
      'custom',
      'daily-safe-review',
      NOW(),
      NOW(),
      'owner'
    )
  `;

  return hive;
}

describe("hive portability", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("exports a deterministic template without secrets or runtime state", async () => {
    const hive = await seedPortableHive();

    const first = await exportHiveTemplate(sql, hive.id);
    const second = await exportHiveTemplate(sql, hive.id);

    expect(second).toEqual(first);
    expect(first.manifest.kind).toBe("hivewright.hive-template");
    expect(first.hive).toMatchObject({
      slug: hive.slug,
      name: "Portable Source",
      type: "digital",
      mission: "Run a portable operation",
      aiBudgetCapCents: 2500,
      aiBudgetWindow: "monthly",
    });
    expect(first.hive).not.toHaveProperty("id");
    expect(first.hive).not.toHaveProperty("workspacePath");
    expect(first.hive).not.toHaveProperty("eaSessionId");

    expect(first.connectors).toEqual([
      expect.objectContaining({
        connectorSlug: "discord-webhook",
        displayName: "Owner Discord",
        credentialId: null,
        envInputs: expect.arrayContaining([
          expect.objectContaining({ key: "DISCORD_WEBHOOK_WEBHOOK_URL", secret: true }),
        ]),
      }),
    ]);
    expect(JSON.stringify(first)).not.toContain("encrypted-secret-value");
    expect(JSON.stringify(first)).not.toContain("runtime error should not export");
    expect(first.goals).toHaveLength(1);
    expect(first.goals[0]).not.toHaveProperty("spentCents");
    expect(first.goals[0]).not.toHaveProperty("sessionId");
    expect(first.goals[0]).not.toHaveProperty("outcomeClassification");
    expect(first.tasks).toEqual([
      expect.objectContaining({ assignedTo: "dev-agent", title: "Starter task", status: "pending" }),
    ]);
    expect(first.tasks[0]).not.toHaveProperty("resultSummary");
    expect(first.schedules).toEqual([
      expect.objectContaining({ cronExpression: "0 9 * * *", originKey: "daily-safe-review" }),
    ]);
    expect(first.schedules[0]).not.toHaveProperty("lastRunAt");
    expect(first.policies.map((policy) => policy.name)).toEqual(["Allow read", "Block destructive"]);
    expect(first.roles.some((role) => role.slug === "dev-agent")).toBe(true);
  });

  it("previews collisions and reconnect-needed env inputs before import", async () => {
    const hive = await seedPortableHive();
    const pkg = await exportHiveTemplate(sql, hive.id);

    const preview = await previewHiveTemplateImport(sql, pkg, {
      slug: hive.slug,
      name: "Portable Copy",
      env: {},
      collisionStrategy: "reject",
    });

    expect(preview.canImport).toBe(false);
    expect(preview.collisions).toEqual([
      { field: "slug", value: hive.slug, strategy: "reject" },
    ]);
    expect(preview.missingEnvInputs).toContain("DISCORD_WEBHOOK_WEBHOOK_URL");
    expect(preview.summary).toMatchObject({
      connectors: 1,
      goals: 1,
      tasks: 1,
      policies: 2,
      schedules: 1,
    });
  });

  it("imports the safe template into a new hive with scrubbed connector credentials", async () => {
    const source = await seedPortableHive();
    const pkg = await exportHiveTemplate(sql, source.id);
    const fixture = createFixtureNamespace("hive-portability-import");

    const result = await importHiveTemplate(sql, pkg, {
      slug: fixture.slug("portable-copy"),
      name: "Portable Copy",
    });

    expect(result.preview.canImport).toBe(true);
    expect(result.hive.slug).not.toBe(source.slug);

    const [install] = await sql<{ credential_id: string | null; config: Record<string, unknown>; last_error: string | null }[]>`
      SELECT credential_id, config, last_error
      FROM connector_installs
      WHERE hive_id = ${result.hive.id}::uuid
    `;
    expect(install.credential_id).toBeNull();
    expect(install.config).toMatchObject({ defaultUsername: "HiveWright" });
    expect(install.config).not.toHaveProperty("webhookUrl");
    expect(install.last_error).toBeNull();

    const [{ count: credentialCount }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM credentials WHERE hive_id = ${result.hive.id}::uuid
    `;
    expect(credentialCount).toBe(0);

    const [createdTask] = await sql<{ status: string; spent_cents: number; result_summary: string | null }[]>`
      SELECT status, spent_cents, result_summary
      FROM tasks
      WHERE hive_id = ${result.hive.id}::uuid
    `;
    expect(createdTask).toEqual({ status: "pending", spent_cents: 0, result_summary: null });
  });

  it("rejects unsupported packages", async () => {
    await expect(previewHiveTemplateImport(sql, { manifest: { kind: "wrong" } } as unknown as HivePortablePackage, {
      slug: "copy",
      name: "Copy",
    })).rejects.toThrow(/Unsupported hive package/i);
  });
});
