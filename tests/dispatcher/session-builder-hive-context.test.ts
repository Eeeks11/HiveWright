import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderSessionPrompt } from "../../src/adapters/context-renderer";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { buildSessionContext } from "../../src/dispatcher/session-builder";
import type { ClaimedTask } from "../../src/dispatcher/types";

async function seedHiveAndTask(
  mission: string | null,
  options: { workspacePath?: string | null; projectWorkspacePath?: string | null } = {},
): Promise<{ hiveId: string; task: ClaimedTask }> {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, description, mission, workspace_path)
    VALUES (
      'SB Hive',
      ${"sb-" + Math.random().toString(36).slice(2, 8)},
      'digital',
      'desc',
      ${mission},
      ${options.workspacePath ?? null}
    )
    RETURNING id
  `;
  const hiveId = hive.id;
  let projectId: string | null = null;

  if (options.projectWorkspacePath) {
    const [project] = await sql<{ id: string }[]>`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${hiveId}, 'app', 'App', ${options.projectWorkspacePath})
      RETURNING id
    `;
    projectId = project.id;
  }

  // role_templates is preserved across truncateAll, so ensure one active role exists.
  await sql`
    INSERT INTO role_templates (slug, name, department, type, role_md, soul_md, tools_md,
                                 recommended_model, adapter_type, active)
    VALUES ('test-role', 'Test Role', 'general', 'executor', '# Role', null, null,
            'anthropic/claude-sonnet-4-6', 'claude-code', true)
    ON CONFLICT (slug) DO UPDATE SET active = true
  `;

  const [taskRow] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, title, brief, assigned_to, created_by, status, project_id)
    VALUES (${hiveId}, 'T', 'do things', 'test-role', 'test', 'active', ${projectId})
    RETURNING id
  `;

  const claimed: ClaimedTask = {
    id: taskRow.id,
    hiveId,
    assignedTo: "test-role",
    createdBy: "test",
    status: "active",
    priority: 0,
    title: "T",
    brief: "do things",
    parentTaskId: null,
    goalId: null,
    sprintNumber: null,
    qaRequired: false,
    acceptanceCriteria: null,
    retryCount: 0,
    doctorAttempts: 0,
    failureReason: null,
    projectId,
  };
  return { hiveId, task: claimed };
}

describe("buildSessionContext — hive context injection", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("populates hiveContext with mission when present", async () => {
    const { task } = await seedHiveAndTask("Deliver polished cabins.");
    const ctx = await buildSessionContext(sql, task);
    expect(ctx.hiveContext).toContain("## Hive Context");
    expect(ctx.hiveContext).toContain("**Mission:**");
    expect(ctx.hiveContext).toContain("Deliver polished cabins.");
  });

  it("populates hiveContext without Mission subsection when mission null", async () => {
    const { task } = await seedHiveAndTask(null);
    const ctx = await buildSessionContext(sql, task);
    expect(ctx.hiveContext).toContain("## Hive Context");
    expect(ctx.hiveContext).not.toContain("**Mission:**");
  });

  it("adds Working in for the resolved project workspace", async () => {
    const { task } = await seedHiveAndTask("Ship it.", { projectWorkspacePath: "/tmp/sb-project" });
    const ctx = await buildSessionContext(sql, task);
    expect(ctx.projectWorkspace).toBe("/tmp/sb-project");
    expect(ctx.hiveContext).toContain("**About:** desc\n**Working in:** /tmp/sb-project");
  });

  it("does not add Working in for operations-only hive tasks", async () => {
    const { task } = await seedHiveAndTask("Run operations.");
    const ctx = await buildSessionContext(sql, task);
    expect(ctx.projectWorkspace).toBeNull();
    expect(ctx.hiveContext).not.toContain("**Working in:**");
  });

  it("falls back to the live runtime hive workspace when the stored hive workspace path is stale", async () => {
    const previousRuntimeRoot = process.env.HIVEWRIGHT_RUNTIME_ROOT;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sb-runtime-"));
    const hiveSlug = "sb-stale-hive";
    const legacyWorkspace = path.join(tmpRoot, "legacy", "projects");
    const runtimeWorkspace = path.join(tmpRoot, "runtime", "hives", hiveSlug, "projects");
    const taskWorkspace = path.join(tmpRoot, "task-workspaces", "task-123");
    fs.mkdirSync(runtimeWorkspace, { recursive: true });
    fs.mkdirSync(taskWorkspace, { recursive: true });
    process.env.HIVEWRIGHT_RUNTIME_ROOT = path.join(tmpRoot, "runtime");

    try {
      const [hive] = await sql<{ id: string }[]>`
        INSERT INTO hives (name, slug, type, description, mission, workspace_path)
        VALUES ('Stale Hive', ${hiveSlug}, 'digital', 'desc', 'Ship safely.', ${legacyWorkspace})
        RETURNING id
      `;
      await sql`
        INSERT INTO role_templates (slug, name, department, type, role_md, soul_md, tools_md,
                                     recommended_model, adapter_type, active)
        VALUES ('test-role', 'Test Role', 'general', 'executor', '# Role', null, null,
                'anthropic/claude-sonnet-4-6', 'claude-code', true)
        ON CONFLICT (slug) DO UPDATE SET active = true
      `;
      const [taskRow] = await sql<{ id: string }[]>`
        INSERT INTO tasks (hive_id, title, brief, assigned_to, created_by, status)
        VALUES (${hive.id}, 'T', 'do things', 'test-role', 'test', 'active')
        RETURNING id
      `;

      const task: ClaimedTask = {
        id: taskRow.id,
        hiveId: hive.id,
        assignedTo: "test-role",
        createdBy: "test",
        status: "active",
        priority: 0,
        title: "T",
        brief: "do things",
        parentTaskId: null,
        goalId: null,
        sprintNumber: null,
        qaRequired: false,
        acceptanceCriteria: null,
        retryCount: 0,
        doctorAttempts: 0,
        failureReason: null,
        projectId: null,
      };

      const ctx = await buildSessionContext(sql, task);
      const prompt = renderSessionPrompt(ctx, { workspace: taskWorkspace });

      expect(ctx.projectWorkspace).toBe(runtimeWorkspace);
      expect(ctx.hiveWorkspacePath).toBe(runtimeWorkspace);
      expect(ctx.credentials.HIVEWRIGHT_RUNTIME_ROOT).toBe(path.join(tmpRoot, "runtime"));
      expect(ctx.credentials.HIVEWRIGHT_ENV_FILE).toBe(path.join(tmpRoot, "runtime", "config", ".env"));
      expect(prompt).toContain(`The owning hive/business workspace is: \`${runtimeWorkspace}\``);
      expect(prompt).not.toContain(legacyWorkspace);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      if (previousRuntimeRoot === undefined) delete process.env.HIVEWRIGHT_RUNTIME_ROOT;
      else process.env.HIVEWRIGHT_RUNTIME_ROOT = previousRuntimeRoot;
    }
  });
});
