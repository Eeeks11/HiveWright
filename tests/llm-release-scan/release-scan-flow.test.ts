import { describe, expect, it, beforeEach } from "vitest";
import { createGetInitiativeRunDetailHandler } from "@/app/api/initiative-runs/[runId]/get-handler";
import { createGetInitiativeRunsHandler } from "@/app/api/initiative-runs/get-handler";
import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import { runLlmReleaseScan } from "@/llm-release-scan";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE = "aaaaaaaa-1111-4111-8111-111111111111";
const SCHEDULE = "bbbbbbbb-2222-4222-8222-222222222222";
const RELEASE_SCAN_DECISION_KIND = "release_scan_model_proposal";
const NEW_MODEL_ID = "openai/gpt-6-test";
const NEW_MODEL_HTML = `
  <html>
    <body>
      <p>The API model id is gpt-6-test.</p>
      <p>Input $1.00 per 1M input tokens. Output $5.00 per 1M output tokens.</p>
    </body>
  </html>
`;

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'release-scan-flow', 'Release Scan Flow', 'digital')
  `;
});

async function runWithSourceText(openaiSourceText: string) {
  return runLlmReleaseScan(
    sql,
    {
      hiveId: HIVE,
      trigger: {
        kind: "schedule",
        scheduleId: SCHEDULE,
      },
    },
    {
      fetchSource: async (url) => ({
        ok: true,
        status: 200,
        text: url.includes("openai") ? openaiSourceText : "<html><body>No new models.</body></html>",
      }),
      now: new Date("2026-04-25T12:00:00.000Z"),
    },
  );
}

async function countReleasePatchTasks(): Promise<number> {
  const [row] = await sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM tasks
    WHERE hive_id = ${HIVE}
      AND assigned_to = 'dev-agent'
      AND created_by = 'decision-release-scan'
  `;
  return row.count;
}

describe("LLM release scan owner-gated flow", () => {
  it("writes a heartbeat-visible run record when no new models are found", async () => {
    const result = await runWithSourceText("<html><body>No new OpenAI models.</body></html>");
    expect(result).toMatchObject({
      newModelsDetected: 0,
      decisionsCreated: 0,
      heartbeatRecorded: true,
    });

    const GET = createGetInitiativeRunsHandler(sql);
    const res = await GET(
      new Request(`http://localhost/api/initiative-runs?hiveId=${HIVE}&limit=5&windowHours=24`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toMatchObject({
      runCount: 1,
      completedRuns: 1,
      evaluatedCandidates: 0,
      createdItems: 0,
    });
    expect(body.data.runs[0]).toMatchObject({
      id: result.runId,
      hiveId: HIVE,
      trigger: "llm-release-scan",
      triggerRef: SCHEDULE,
      status: "completed",
      noopCount: 1,
      created: { goals: 0, tasks: 0, decisions: 0 },
    });

    const GET_DETAIL = createGetInitiativeRunDetailHandler(sql);
    const detail = await GET_DETAIL(
      new Request(`http://localhost/api/initiative-runs/${result.runId}?hiveId=${HIVE}`),
      { params: Promise.resolve({ runId: result.runId }) },
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.data.run.decisions).toEqual([
      expect.objectContaining({
        candidate_kind: "llm-release-scan",
        action_taken: "noop",
        rationale: "Weekly LLM release scan completed; no unregistered candidate models were found.",
      }),
    ]);
    expect(detailBody.data.run.decisions[0].candidate_key).toContain("llm-release-scan:heartbeat");
  });

  it("writes a run record and pending owner decision for a newly discovered model", async () => {
    const result = await runWithSourceText(NEW_MODEL_HTML);
    expect(result).toMatchObject({
      newModelsDetected: 1,
      decisionsCreated: 1,
    });

    const [decision] = await sql<Array<{
      id: string;
      status: string;
      kind: string;
      title: string;
      options: { modelProposal: { source: string; modelId: string; provider: string } };
    }>>`
      SELECT id, status, kind, title, options
      FROM decisions
      WHERE hive_id = ${HIVE}
    `;
    expect(decision).toMatchObject({
      status: "pending",
      kind: RELEASE_SCAN_DECISION_KIND,
      title: `Tier-2: review new openai model ${NEW_MODEL_ID}`,
    });
    expect(decision.options.modelProposal).toMatchObject({
      source: "release-scan",
      modelId: NEW_MODEL_ID,
      provider: "openai",
    });

    const [ledger] = await sql<Array<{ created_decision_id: string; action_taken: string }>>`
      SELECT created_decision_id, action_taken
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
    `;
    expect(ledger).toEqual({
      created_decision_id: decision.id,
      action_taken: "decision",
    });
    expect(await countReleasePatchTasks()).toBe(0);

    const GET = createGetInitiativeRunDetailHandler(sql);
    const res = await GET(
      new Request(`http://localhost/api/initiative-runs/${result.runId}?hiveId=${HIVE}`),
      { params: Promise.resolve({ runId: result.runId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.run).toMatchObject({
      id: result.runId,
      trigger: "llm-release-scan",
      createdCount: 1,
      created: { goals: 0, tasks: 0, decisions: 1 },
    });
    expect(body.data.run.decisions[0]).toMatchObject({
      action_taken: "decision",
      candidate_key: `llm-release-scan:openai:${NEW_MODEL_ID}`,
      candidate_kind: "llm-release-scan",
    });
  });

  it("queues exactly one dev-agent patch task when the owner approves the release-scan decision", async () => {
    await runWithSourceText(NEW_MODEL_HTML);
    const [decision] = await sql<Array<{ id: string }>>`
      SELECT id FROM decisions WHERE hive_id = ${HIVE}
    `;

    const req = new Request(`http://localhost/api/decisions/${decision.id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: HIVE, response: "approved", comment: "Proceed with the registry patch" }),
    });
    const res = await respondToDecision(req, {
      params: Promise.resolve({ id: decision.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.queuedTaskId).toBeTruthy();

    const tasks = await sql<Array<{
      id: string;
      assigned_to: string;
      created_by: string;
      title: string;
      brief: string;
      qa_required: boolean;
    }>>`
      SELECT id, assigned_to, created_by, title, brief, qa_required
      FROM tasks
      WHERE hive_id = ${HIVE}
    `;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: body.data.queuedTaskId,
      assigned_to: "dev-agent",
      created_by: "decision-release-scan",
      title: `Patch model registry for ${NEW_MODEL_ID}`,
      qa_required: true,
    });
    expect(tasks[0].brief).toContain(`release-scan-decision:${decision.id}`);

    const secondApproval = await respondToDecision(
      new Request(`http://localhost/api/decisions/${decision.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: HIVE, response: "approved", comment: "Proceed with the registry patch" }),
      }),
      { params: Promise.resolve({ id: decision.id }) },
    );
    expect(secondApproval.status).toBe(200);
    const secondBody = await secondApproval.json();
    expect(secondBody.data.queuedTaskId).toBe(body.data.queuedTaskId);
    expect(await countReleasePatchTasks()).toBe(1);
  });

  it("suppresses duplicate proposals while a commented approval has active patch work", async () => {
    await runWithSourceText(NEW_MODEL_HTML);
    const [decision] = await sql<Array<{ id: string }>>`
      SELECT id FROM decisions WHERE hive_id = ${HIVE}
    `;

    const approval = await respondToDecision(
      new Request(`http://localhost/api/decisions/${decision.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId: HIVE,
          response: "approved",
          comment: "Proceed with the registry patch",
        }),
      }),
      { params: Promise.resolve({ id: decision.id }) },
    );
    expect(approval.status).toBe(200);
    expect(await countReleasePatchTasks()).toBe(1);

    const [recordedDecision] = await sql<Array<{
      owner_response: string | null;
      selected_option_key: string | null;
    }>>`
      SELECT owner_response, selected_option_key FROM decisions WHERE id = ${decision.id}
    `;
    expect(recordedDecision.owner_response).toBe("approved: Proceed with the registry patch");

    const result = await runWithSourceText(NEW_MODEL_HTML);
    expect(result).toMatchObject({
      newModelsDetected: 1,
      decisionsCreated: 0,
      heartbeatRecorded: false,
    });

    const decisions = await sql<Array<{ id: string }>>`
      SELECT id FROM decisions WHERE hive_id = ${HIVE}
    `;
    expect(decisions).toHaveLength(1);
    expect(await countReleasePatchTasks()).toBe(1);

    const [runDecision] = await sql<
      Array<{
        action_taken: string;
        suppression_reason: string | null;
        evidence: { priorOwnerResponse?: string | null };
      }>
    >`
      SELECT action_taken, suppression_reason, evidence
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
    `;
    expect(runDecision).toMatchObject({
      action_taken: "suppress",
      suppression_reason: "cooldown_active",
    });
    expect(runDecision.evidence.priorOwnerResponse).toBe("approved: Proceed with the registry patch");
  });

  it("suppresses duplicate proposals while an approved release-scan patch task is running", async () => {
    await runWithSourceText(NEW_MODEL_HTML);
    const [decision] = await sql<Array<{ id: string }>>`
      SELECT id FROM decisions WHERE hive_id = ${HIVE}
    `;

    const approval = await respondToDecision(
      new Request(`http://localhost/api/decisions/${decision.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: HIVE, response: "approved", comment: "Proceed with the registry patch" }),
      }),
      { params: Promise.resolve({ id: decision.id }) },
    );
    expect(approval.status).toBe(200);
    const approvalBody = await approval.json();
    expect(approvalBody.data.queuedTaskId).toBeTruthy();

    await sql`
      UPDATE tasks
      SET status = 'running'
      WHERE id = ${approvalBody.data.queuedTaskId}
    `;

    const result = await runWithSourceText(NEW_MODEL_HTML);
    expect(result).toMatchObject({
      newModelsDetected: 1,
      decisionsCreated: 0,
      heartbeatRecorded: false,
    });

    const decisions = await sql<Array<{ id: string }>>`
      SELECT id FROM decisions WHERE hive_id = ${HIVE}
    `;
    expect(decisions).toHaveLength(1);
    expect(await countReleasePatchTasks()).toBe(1);

    const [runDecision] = await sql<Array<{ action_taken: string; suppression_reason: string | null }>>`
      SELECT action_taken, suppression_reason
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
    `;
    expect(runDecision).toMatchObject({
      action_taken: "suppress",
      suppression_reason: "cooldown_active",
    });
  });

  it("does not queue patch tasks while the decision is pending or after rejection", async () => {
    await runWithSourceText(NEW_MODEL_HTML);
    const [decision] = await sql<Array<{ id: string }>>`
      SELECT id FROM decisions WHERE hive_id = ${HIVE}
    `;
    expect(await countReleasePatchTasks()).toBe(0);

    const res = await respondToDecision(
      new Request(`http://localhost/api/decisions/${decision.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: HIVE, response: "rejected", comment: "Do not patch this model" }),
      }),
      { params: Promise.resolve({ id: decision.id }) },
    );
    expect(res.status).toBe(200);
    expect(await countReleasePatchTasks()).toBe(0);
  });

  it("creates a fresh owner-review proposal when official GPT-5.6 evidence appears after a prior rejection", async () => {
    const [priorRun] = await sql<Array<{ id: string }>>`
      INSERT INTO initiative_runs (
        hive_id,
        trigger_type,
        trigger_ref,
        status,
        started_at,
        completed_at,
        evaluated_candidates,
        created_count,
        created_goals,
        created_tasks,
        created_decisions,
        suppressed_count,
        noop_count,
        suppression_reasons,
        guardrail_config,
        run_failures,
        failure_reason
      )
      VALUES (
        ${HIVE},
        'llm-release-scan',
        ${SCHEDULE},
        'completed',
        ${new Date("2026-06-29T10:00:00.000Z")},
        ${new Date("2026-06-29T10:05:00.000Z")},
        1,
        1,
        0,
        0,
        1,
        0,
        0,
        ${sql.json({})},
        ${sql.json({ decisionCooldownHours: 720 })},
        0,
        NULL
      )
      RETURNING id
    `;

    const [rejectedDecision] = await sql<Array<{ id: string }>>`
      INSERT INTO decisions (
        hive_id,
        title,
        context,
        recommendation,
        priority,
        status,
        kind,
        owner_response,
        created_at,
        resolved_at
      )
      VALUES (
        ${HIVE},
        'Tier-2: review new openai model openai/gpt-5.6',
        'Created before official OpenAI docs listed GPT-5.6.',
        'Wait for official OpenAI documentation before patching.',
        'normal',
        'resolved',
        ${RELEASE_SCAN_DECISION_KIND},
        'rejected',
        ${new Date("2026-06-29T10:01:00.000Z")},
        ${new Date("2026-06-30T09:00:00.000Z")}
      )
      RETURNING id
    `;

    await sql`
      INSERT INTO initiative_run_decisions (
        run_id,
        hive_id,
        trigger_type,
        candidate_key,
        candidate_ref,
        action_taken,
        rationale,
        dedupe_key,
        cooldown_hours,
        evidence,
        created_decision_id,
        created_at
      )
      VALUES (
        ${priorRun.id},
        ${HIVE},
        'llm-release-scan',
        'llm-release-scan:openai:openai/gpt-5.6',
        'openai/gpt-5.6',
        'decision',
        'Created owner-review proposal before GPT-5.6 was officially documented.',
        'llm-release-scan:openai:openai/gpt-5.6',
        720,
        ${sql.json({
          candidate: {
            provider: "openai",
            modelId: "openai/gpt-5.6",
          },
        })},
        ${rejectedDecision.id},
        ${new Date("2026-06-29T10:01:00.000Z")}
      )
    `;

    const result = await runLlmReleaseScan(
      sql,
      {
        hiveId: HIVE,
        trigger: {
          kind: "schedule",
          scheduleId: SCHEDULE,
        },
      },
      {
        researchOfficialSources: async () => [{
          provider: "openai",
          url: "https://platform.openai.com/docs/models",
          ok: true,
          researchMethod: "agent-web-search",
          text: `
            Official OpenAI API models page on July 10, 2026 lists gpt-5.6.
            Input $2.50 per 1M input tokens. Output $10.00 per 1M output tokens.
          `,
        }],
        now: new Date("2026-07-10T12:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      newModelsDetected: 1,
      decisionsCreated: 1,
      heartbeatRecorded: false,
    });

    const decisions = await sql<Array<{
      title: string;
      status: string;
      owner_response: string | null;
      created_at: Date;
    }>>`
      SELECT title, status, owner_response, created_at
      FROM decisions
      WHERE hive_id = ${HIVE}
      ORDER BY created_at ASC
    `;
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      title: "Tier-2: review new openai model openai/gpt-5.6",
      status: "resolved",
      owner_response: "rejected",
    });
    expect(decisions[1]).toMatchObject({
      title: "Tier-2: review new openai model openai/gpt-5.6",
      status: "pending",
      owner_response: null,
    });

    const runDecisions = await sql<Array<{ action_taken: string; suppression_reason: string | null }>>`
      SELECT action_taken, suppression_reason
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
      ORDER BY created_at ASC
    `;
    expect(runDecisions).toEqual([
      {
        action_taken: "decision",
        suppression_reason: null,
      },
    ]);
  });
});
