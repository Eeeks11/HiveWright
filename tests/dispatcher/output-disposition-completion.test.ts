import { beforeEach, describe, expect, it } from "vitest";
import { completeTask } from "@/dispatcher/task-claimer";
import { ANALYST_OUTPUT_DISPOSITION_KIND } from "@/tasks/output-disposition";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('output-disposition-completion', 'Output Disposition Completion', 'digital')
    RETURNING *
  `;
  hiveId = hive.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('output-disposition-test-role', 'Output Disposition Test Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("completeTask output disposition guard", () => {
  it("completes ordinary GitHub Release publication without analyst routing disposition", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (
        ${hiveId},
        'output-disposition-test-role',
        'owner',
        'Publish v1.0 to GitHub Releases',
        'Create the v1.0 GitHub Release and return the release artifact URL.',
        'active'
      )
      RETURNING id
    `;

    const releaseUrl = "https://github.com/Eeeks11/HiveWright/releases/tag/v1.0";
    await completeTask(sql, task.id, `Published v1.0 to GitHub Releases: ${releaseUrl}`);

    const [updated] = await sql`
      SELECT status, result_summary, failure_reason, terminal_disposition
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.result_summary).toContain(releaseUrl);
    expect(updated.failure_reason).toBeNull();
    expect(updated.terminal_disposition).toBeNull();
  });

  it("records canonical disposition for GitHub issue routing publication output", async () => {
    const [task] = await seedRoutingTask("Route prior analyst findings to a GitHub issue or record why no follow-up is needed.");

    await completeTask(sql, task.id, "Published prior findings to GitHub issue #191 with verification evidence.");

    const [updated] = await sql`
      SELECT status, terminal_disposition
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.terminal_disposition).toMatchObject({
      kind: ANALYST_OUTPUT_DISPOSITION_KIND,
      terminal: true,
      final_disposition_label: "github_issue_backlog_open",
      evidence: { disposition: "github_route", githubRefs: expect.arrayContaining(["GitHub issue #191"]) },
    });
  });

  it("records canonical disposition for GitHub PR routing publication output", async () => {
    const [task] = await seedRoutingTask("Route prior analyst findings to a GitHub issue or PR, or record why no follow-up is needed.");

    await completeTask(sql, task.id, "Published prior findings to https://github.com/Eeeks11/HiveWright/pull/217 with verification evidence.");

    const [updated] = await sql`
      SELECT status, terminal_disposition
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.terminal_disposition).toMatchObject({
      kind: ANALYST_OUTPUT_DISPOSITION_KIND,
      terminal: true,
      final_disposition_label: "github_issue_backlog_open",
      evidence: {
        disposition: "github_route",
        githubRefs: expect.arrayContaining(["https://github.com/Eeeks11/HiveWright/pull/217"]),
      },
    });
  });

  it("records deliberate no-follow-up for routing publication output", async () => {
    const [task] = await seedRoutingTask("Route prior analyst findings to a GitHub issue or record why no follow-up is needed.");

    await completeTask(sql, task.id, "Recorded explicit no-follow-up terminal closeout; no further action is required.");

    const [updated] = await sql`
      SELECT status, terminal_disposition
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.terminal_disposition).toMatchObject({
      kind: ANALYST_OUTPUT_DISPOSITION_KIND,
      terminal: true,
      final_disposition_label: "reference_only_output",
      evidence: { disposition: "deliberate_no_follow_up", githubRefs: [] },
    });
  });

  it("rejects analyst routing completion when only a GitHub Release URL is recorded", async () => {
    const [task] = await seedRoutingTask("Route prior analyst findings to a GitHub issue or PR, or record why no follow-up is needed.");

    await completeTask(sql, task.id, "Published notes at https://github.com/Eeeks11/HiveWright/releases/tag/v1.0");

    const [updated] = await sql`
      SELECT status, failure_reason, completed_at, terminal_disposition
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("failed");
    expect(updated.failure_reason).toContain("Routing/publication task completion rejected");
    expect(updated.completed_at).toBeNull();
    expect(updated.terminal_disposition).toBeNull();
  });
});

async function seedRoutingTask(brief: string) {
  return sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
    VALUES (
      ${hiveId},
      'output-disposition-test-role',
      'owner',
      'Publish prior findings to GitHub',
      ${brief},
      'active'
    )
    RETURNING id
  `;
}
