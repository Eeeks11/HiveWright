import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "./_lib/test-db";
import { reconcileReferenceOnlyTerminalDispositions } from "@/supervisor/reference-terminal-disposition";
import { scanHive } from "@/supervisor/scan";
import { ANALYST_OUTPUT_DISPOSITION_KIND } from "@/tasks/output-disposition";

const HIVE_ID = "11111111-1111-1111-1111-111111111191";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'output-disposition-test', 'Output Disposition Test', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type, terminal)
    VALUES
      ('research-analyst', 'Research Analyst', 'executor', 'claude-code', false),
      ('system-health-auditor', 'System Health Auditor', 'executor', 'claude-code', false),
      ('operations-coordinator', 'Operations Coordinator', 'executor', 'claude-code', false)
    ON CONFLICT (slug) DO UPDATE SET terminal = false
  `;
});

describe("analyst output canonical disposition", () => {
  it("records canonical disposition for analyst outputs linked to GitHub or deliberate no-follow-up", async () => {
    const githubTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa3516";
    const noFollowUpTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa3517";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, result_summary, completed_at, updated_at)
      VALUES
        (
          ${githubTaskId}, ${HIVE_ID}, 'research-analyst', 'schedule', 'completed',
          'Daily AI and market signal scan',
          'Analyst scan output with a downstream GitHub issue route.',
          'The durable analyst output is now tracked in GitHub issue #191.',
          NOW() - interval '2 hours', NOW() - interval '2 hours'
        ),
        (
          ${noFollowUpTaskId}, ${HIVE_ID}, 'system-health-auditor', 'schedule', 'completed',
          'System health audit evidence review',
          'Auditor review output with explicit terminal disposition.',
          'Recorded explicit no-follow-up terminal closeout; no further action is required.',
          NOW() - interval '2 hours', NOW() - interval '2 hours'
        )
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content, title, artifact_kind)
      VALUES
        (${githubTaskId}, ${HIVE_ID}, 'research-analyst', 'Routed to GitHub issue #191.', 'Market scan', 'reference_report'),
        (${noFollowUpTaskId}, ${HIVE_ID}, 'system-health-auditor', 'Explicit no-follow-up terminal closeout recorded.', 'Quality review', 'reference_report')
    `;

    const reconciled = await reconcileReferenceOnlyTerminalDispositions(sql, HIVE_ID, {
      now: new Date("2026-07-03T00:00:00.000Z"),
    });
    expect(reconciled.disposed).toBe(2);

    const rows = await sql<Array<{ id: string; terminal_disposition: Record<string, unknown> }>>`
      SELECT id, terminal_disposition
      FROM tasks
      WHERE id IN (${githubTaskId}, ${noFollowUpTaskId})
      ORDER BY id
    `;
    expect(rows.map((row) => row.terminal_disposition.kind)).toEqual([
      ANALYST_OUTPUT_DISPOSITION_KIND,
      ANALYST_OUTPUT_DISPOSITION_KIND,
    ]);
    expect(rows[0].terminal_disposition).toMatchObject({
      terminal_status: "closed_with_follow_up",
      final_disposition_label: "github_issue_backlog_open",
      evidence: { disposition: "github_route", githubRefs: expect.arrayContaining(["GitHub issue #191"]) },
    });
    expect(rows[1].terminal_disposition).toMatchObject({
      terminal_status: "closed",
      final_disposition_label: "reference_only_output",
      evidence: { disposition: "deliberate_no_follow_up" },
    });

    const report = await scanHive(sql, HIVE_ID);
    for (const taskId of [githubTaskId, noFollowUpTaskId]) {
      expect(report.findings.some((f) => f.id === `unsatisfied_completion:${taskId}`)).toBe(false);
      expect(report.findings.some((f) => f.id === `orphan_output:${taskId}`)).toBe(false);
    }
  });

  it("keeps routing publication tasks as residue until a route or terminal disposition is recorded", async () => {
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa3518";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, result_summary, completed_at, updated_at)
      VALUES (
        ${taskId}, ${HIVE_ID}, 'operations-coordinator', 'schedule', 'completed',
        'Publish prior findings to GitHub',
        'Route prior analyst findings to a GitHub issue or record why no follow-up is needed.',
        'Reviewed the prior findings and prepared a publication summary, but no issue/PR or terminal no-follow-up disposition was recorded.',
        NOW() - interval '2 hours', NOW() - interval '2 hours'
      )
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content, title, artifact_kind)
      VALUES (${taskId}, ${HIVE_ID}, 'operations-coordinator', 'Prepared routing notes without publishing route evidence.', 'Routing notes', 'reference_report')
    `;

    const reconciled = await reconcileReferenceOnlyTerminalDispositions(sql, HIVE_ID);
    expect(reconciled.disposed).toBe(0);

    const [task] = await sql<Array<{ terminal_disposition: Record<string, unknown> | null }>>`
      SELECT terminal_disposition FROM tasks WHERE id = ${taskId}
    `;
    expect(task.terminal_disposition).toBeNull();

    const report = await scanHive(sql, HIVE_ID);
    expect(report.findings.some((f) => f.id === `unsatisfied_completion:${taskId}`)).toBe(true);
    expect(report.findings.some((f) => f.id === `orphan_output:${taskId}`)).toBe(true);
  });
});
