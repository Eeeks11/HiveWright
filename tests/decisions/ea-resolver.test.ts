import { beforeEach, describe, expect, it } from "vitest";
import {
  applyEaResolution,
  buildResolverPrompt,
  forceEscalateAfterEaFailure,
  decisionRequiresOwnerApproval,
  decisionTextRequiresOwnerApproval,
  parseEaResolverOutput,
} from "@/decisions/ea-resolver";
import { findStuckBlockedTasks } from "@/dispatcher/watchdog";
import { testSql as sql, truncateAll } from "../_lib/test-db";

describe("parseEaResolverOutput", () => {
  it("accepts a plain JSON object without a fenced markdown block", () => {
    const result = parseEaResolverOutput(
      JSON.stringify({
        action: "auto_resolve",
        reasoning: "The stale internal decision was already handled by the recovery pause.",
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({
        action: "auto_resolve",
        reasoning: "The stale internal decision was already handled by the recovery pause.",
        ownerTitle: undefined,
        ownerContext: undefined,
        ownerRecommendation: undefined,
        ownerPriority: undefined,
        ownerOptions: undefined,
      });
    }
  });

  it("accepts prose followed by an unfenced JSON decision object", () => {
    const result = parseEaResolverOutput(
      [
        "I checked the task and cancelled the stale duplicate.",
        JSON.stringify({
          action: "auto_resolve",
          reasoning: "The stale duplicate task was cancelled, so no owner action is needed.",
        }),
      ].join("\n\n"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe("auto_resolve");
      expect(result.result.reasoning).toContain("stale duplicate");
    }
  });

  it("uses the last usable JSON decision object and ignores earlier incidental JSON", () => {
    const result = parseEaResolverOutput(
      [
        'Raw tool data: {"status":"ok","action":"not_a_resolver_action"}',
        JSON.stringify({
          action: "needs_more_info",
          reasoning: "The API was unavailable; retry the EA pass with fresh context.",
        }),
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.action).toBe("needs_more_info");
  });

  it("still rejects prose when no parseable EA resolver JSON object is present", () => {
    const result = parseEaResolverOutput("I checked this and it should be dismissed.");

    expect(result).toEqual({
      ok: false,
      reason: "no EA resolver JSON object with a known action found in output",
    });
  });

  it("accepts ownerOptions for multi-way named escalations", () => {
    const result = parseEaResolverOutput(
      [
        "I checked the goal and this needs owner judgement.",
        "```json",
        JSON.stringify({
          action: "escalate_to_owner",
          reasoning: "The Gemini CLI adapter has multiple viable auth/runtime paths.",
          ownerTitle: "Choose Gemini CLI auth path",
          ownerContext: "The adapter can continue through several named paths.",
          ownerRecommendation: "Use GCA login.",
          ownerPriority: "urgent",
          ownerOptions: [
            {
              key: "api-key-runtime",
              label: "Use Gemini API key runtime",
              consequence: "Fastest automation path, but stores a credential.",
              response: "approved",
            },
            {
              key: "gca-login",
              label: "Use GCA login",
              consequence: "Owner can select this directly instead of using Discuss.",
              canonicalResponse: "approved",
            },
            {
              key: "defer-gemini-adapter",
              label: "Defer Gemini adapter work",
              consequence: "Leaves the goal parked.",
              canonical_response: "rejected",
            },
          ],
        }),
        "```",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.ownerOptions?.map((option) => option.key)).toEqual([
        "api-key-runtime",
        "gca-login",
        "defer-gemini-adapter",
      ]);
      expect(result.result.ownerOptions?.[1]).toMatchObject({
        label: "Use GCA login",
        canonicalResponse: "approved",
      });
    }
  });

  it("does not require ownerOptions for simple approve/reject escalations", () => {
    const result = parseEaResolverOutput(
      [
        "```json",
        JSON.stringify({
          action: "escalate_to_owner",
          reasoning: "This is a simple spend approval.",
          ownerTitle: "Approve extra budget",
          ownerContext: "The goal needs another $50.",
          ownerRecommendation: "Approve the spend.",
        }),
        "```",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.ownerOptions).toBeUndefined();
  });

  it("accepts an owner-facing Codex subscription reuse option for OpenAI auth route choices", () => {
    const result = parseEaResolverOutput(
      [
        "The raw options missed the owner's already-paid route, so I rewrote the choices.",
        "```json",
        JSON.stringify({
          action: "escalate_to_owner",
          reasoning: "OpenAI image generation has multiple viable auth paths, including existing Codex subscription auth.",
          ownerTitle: "Choose OpenAI image auth path",
          ownerContext: "Image generation needs an auth route. The existing Codex subscription path should be selectable if technically supported.",
          ownerRecommendation: "Try the existing Codex subscription auth before asking for a new API key.",
          ownerOptions: [
            {
              key: "existing-codex-subscription-auth",
              label: "Use existing Codex subscription auth",
              consequence: "Reuses an already-paid owner subscription if the adapter can support it.",
              response: "approved",
            },
            {
              key: "new-openai-api-key",
              label: "Provide a new OpenAI API key",
              consequence: "Requires a separate credential and may add API billing.",
              response: "approved",
            },
            {
              key: "switch-installed-image-path",
              label: "Use another installed image path",
              consequence: "Avoids new OpenAI credential work if a supported connector is already available.",
              response: "approved",
            },
            {
              key: "defer-image-generation",
              label: "Defer image generation",
              consequence: "Leaves image work blocked until an auth path is chosen.",
              response: "rejected",
            },
          ],
        }),
        "```",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.ownerOptions?.map((option) => option.key)).toContain(
        "existing-codex-subscription-auth",
      );
      expect(result.result.ownerOptions?.map((option) => option.key)).toContain("new-openai-api-key");
      expect(result.result.ownerOptions?.map((option) => option.key)).toContain("defer-image-generation");
    }
  });

  it("instructs EA escalation to add reuse-existing credential and subscription paths", () => {
    const prompt = buildResolverPrompt({
      decisionId: "decision-1",
      hiveId: "hive-1",
      goalId: null,
      taskId: null,
      title: "Image generation needs an OpenAI API key",
      context: "Raw options only included provide key, switch path, or defer.",
      recommendation: "Ask for a new OpenAI API key.",
      options: [
        { key: "new-openai-api-key", label: "Provide a new OpenAI API key" },
        { key: "switch-path", label: "Switch path" },
        { key: "defer", label: "Defer" },
      ],
      priority: "normal",
      kind: "credential_blocker",
    });

    expect(prompt).toContain("reuse an existing credential");
    expect(prompt).toContain("Codex auth");
    expect(prompt).toContain("Use existing Codex subscription auth");
  });
});

describe.sequential("applyEaResolution", () => {
  const HIVE_ID = "77777777-7777-7777-7777-777777777777";

  beforeEach(async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${HIVE_ID}, 'ea-resolver-options', 'EA Resolver Options', 'digital')
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('ea-resolver-test-role', 'EA Resolver Test Role', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
  });

  it("stores ownerOptions when escalating a named multi-way decision", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, status)
      VALUES (${HIVE_ID}, 'Raw auth failure', 'raw context', null, 'ea_review')
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "escalate_to_owner",
      reasoning: "Multiple Gemini CLI auth paths are viable.",
      ownerTitle: "Choose Gemini CLI auth path",
      ownerContext: "The adapter can proceed through one of these paths.",
      ownerRecommendation: "Use GCA login.",
      ownerPriority: "urgent",
      ownerOptions: [
        {
          key: "api-key-runtime",
          label: "Use Gemini API key runtime",
          consequence: "Fast but stores a credential.",
          response: "approved",
        },
        {
          key: "gca-login",
          label: "Use GCA login",
          consequence: "Owner can select this directly instead of using Discuss.",
          response: "approved",
        },
        {
          key: "defer-gemini-adapter",
          label: "Defer Gemini adapter work",
          consequence: "Leaves the goal parked.",
          response: "rejected",
        },
      ],
    });

    const [row] = await sql<{ status: string; title: string; options: Array<{ key: string; label: string; response: string }> }[]>`
      SELECT status, title, options FROM decisions WHERE id = ${decision.id}
    `;
    expect(row.status).toBe("pending");
    expect(row.title).toBe("Choose Gemini CLI auth path");
    expect(row.options).toEqual([
      expect.objectContaining({ key: "api-key-runtime", response: "approved" }),
      expect.objectContaining({ key: "gca-login", label: "Use GCA login" }),
      expect.objectContaining({ key: "defer-gemini-adapter", response: "rejected" }),
    ]);
  });

  it("marks EA auto-resolved decisions with the EA resolver and a timeline message", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, title, context, recommendation, status,
        owner_response, ea_attempts
      )
      VALUES (
        ${HIVE_ID}, 'Owner discussion gave direction', 'raw context',
        null, 'pending', 'discussed: continue with the design lane', 0
      )
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "auto_resolve",
      reasoning: "The owner discussion gave a concrete direction, so the EA can resolve it.",
    });

    const [row] = await sql<
      { status: string; owner_response: string; resolved_by: string | null; resolved_at: Date | null }[]
    >`
      SELECT status, owner_response, resolved_by, resolved_at
      FROM decisions
      WHERE id = ${decision.id}
    `;
    expect(row.status).toBe("resolved");
    expect(row.resolved_by).toBe("ea-resolver");
    expect(row.resolved_at).not.toBeNull();
    expect(row.owner_response).toContain("ea-decided:");

    const messages = await sql<{ sender: string; content: string }[]>`
      SELECT sender, content FROM decision_messages WHERE decision_id = ${decision.id}
    `;
    expect(messages).toEqual([
      expect.objectContaining({
        sender: "ea-resolver",
        content: expect.stringContaining("EA auto-resolved"),
      }),
    ]);
  });

  it("finalizes the linked blocked task and active capsule when EA auto-resolves an owner handoff", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${HIVE_ID}, 'Owner handoff goal', 'active')
      RETURNING id
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status, goal_id,
        updated_at, result_summary
      )
      VALUES (
        ${HIVE_ID}, 'ea-resolver-test-role', 'owner', 'Prepare owner handoff',
        'Finish the deliverable and ask for owner input.', 'blocked', ${goal.id},
        NOW() - INTERVAL '6 hours', NULL
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO task_execution_capsules (
        task_id, hive_id, adapter_type, model, session_id, status, qa_state, last_output
      )
      VALUES (
        ${task.id}, ${HIVE_ID}, 'claude-code', 'claude-sonnet', 'session-1',
        'active', 'not_required', 'Completed output that requested owner input.'
      )
    `;
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, goal_id, task_id, title, context, recommendation, status, kind, route_metadata
      )
      VALUES (
        ${HIVE_ID}, ${goal.id}, ${task.id}, 'Hive needs your input',
        'The EA can answer this owner-handoff request from existing context.',
        null, 'ea_review', 'decision',
        ${sql.json({ source: "owner_handoff", taskId: task.id, autoDetected: true })}
      )
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "auto_resolve",
      reasoning: "The owner preference is already known; continue with the safe default.",
    });

    const [updatedTask] = await sql<{
      status: string;
      completed_at: Date | null;
      failure_reason: string | null;
      result_summary: string | null;
    }[]>`
      SELECT status, completed_at, failure_reason, result_summary
      FROM tasks
      WHERE id = ${task.id}
    `;
    expect(updatedTask.status).toBe("completed");
    expect(updatedTask.completed_at).not.toBeNull();
    expect(updatedTask.failure_reason).toBeNull();
    expect(updatedTask.result_summary).toBe("Completed output that requested owner input.");

    const [capsule] = await sql<{ status: string; qa_state: string }[]>`
      SELECT status, qa_state
      FROM task_execution_capsules
      WHERE task_id = ${task.id}
    `;
    expect(capsule).toEqual({ status: "completed", qa_state: "passed" });

    const stuck = await findStuckBlockedTasks(sql, 4 * 60 * 60 * 1000);
    expect(stuck.some((row) => row.id === task.id)).toBe(false);
  });

  it("does not finalize non-owner-handoff decisions or disturbed failed capsules", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${HIVE_ID}, 'Non handoff goal', 'active')
      RETURNING id
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, goal_id, updated_at)
      VALUES (
        ${HIVE_ID}, 'ea-resolver-test-role', 'owner', 'Blocked runtime task',
        'Blocked on a runtime guard.', 'blocked', ${goal.id}, NOW() - INTERVAL '6 hours'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO task_execution_capsules (task_id, hive_id, adapter_type, status, qa_state)
      VALUES (${task.id}, ${HIVE_ID}, 'claude-code', 'qa_failed', 'failed')
    `;
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, status, kind, route_metadata)
      VALUES (
        ${HIVE_ID}, ${goal.id}, ${task.id}, 'Runtime guard review', 'Internal runtime blocker.',
        'ea_review', 'runtime_guard', ${sql.json({ source: "runtime_guard", taskId: task.id })}
      )
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "auto_resolve",
      reasoning: "Runtime guard was handled separately.",
    });

    const [updatedTask] = await sql<{ status: string; completed_at: Date | null }[]>`
      SELECT status, completed_at FROM tasks WHERE id = ${task.id}
    `;
    expect(updatedTask.status).toBe("blocked");
    expect(updatedTask.completed_at).toBeNull();

    const [capsule] = await sql<{ status: string; qa_state: string }[]>`
      SELECT status, qa_state FROM task_execution_capsules WHERE task_id = ${task.id}
    `;
    expect(capsule).toEqual({ status: "qa_failed", qa_state: "failed" });
  });

  it("does not finalize pending owner-visible handoff decisions before EA resolves them", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${HIVE_ID}, 'Pending owner decision goal', 'active')
      RETURNING id
    `;
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, goal_id, updated_at)
      VALUES (
        ${HIVE_ID}, 'ea-resolver-test-role', 'owner', 'Await owner-visible handoff',
        'Needs owner judgement.', 'blocked', ${goal.id}, NOW() - INTERVAL '6 hours'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO task_execution_capsules (task_id, hive_id, adapter_type, status, qa_state)
      VALUES (${task.id}, ${HIVE_ID}, 'claude-code', 'active', 'not_required')
    `;
    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, status, kind, route_metadata)
      VALUES (
        ${HIVE_ID}, ${goal.id}, ${task.id}, 'Owner must choose', 'Owner-visible choice.',
        'pending', 'decision', ${sql.json({ source: "owner_handoff", taskId: task.id })}
      )
    `;

    const [updatedTask] = await sql<{ status: string; completed_at: Date | null }[]>`
      SELECT status, completed_at FROM tasks WHERE id = ${task.id}
    `;
    expect(updatedTask.status).toBe("blocked");
    expect(updatedTask.completed_at).toBeNull();

    const [capsule] = await sql<{ status: string; qa_state: string }[]>`
      SELECT status, qa_state FROM task_execution_capsules WHERE task_id = ${task.id}
    `;
    expect(capsule).toEqual({ status: "active", qa_state: "not_required" });
  });

  it("keeps owner-punted decisions pending instead of auto-resolving them", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, status)
      VALUES (${HIVE_ID}, 'Needs owner judgement', 'raw context', null, 'ea_review')
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "escalate_to_owner",
      reasoning: "This still needs the owner to choose between product directions.",
      ownerTitle: "Choose product direction",
      ownerContext: "The EA cannot infer this from the discussion.",
      ownerRecommendation: "Pick the option that best matches the business intent.",
    });

    const [row] = await sql<{ status: string; resolved_by: string | null; resolved_at: Date | null }[]>`
      SELECT status, resolved_by, resolved_at
      FROM decisions
      WHERE id = ${decision.id}
    `;
    expect(row.status).toBe("pending");
    expect(row.resolved_by).toBeNull();
    expect(row.resolved_at).toBeNull();
  });

  it("stores the Codex subscription reuse option when EA rewrites an OpenAI auth decision", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, status)
      VALUES (${HIVE_ID}, 'Image generation needs an OpenAI API key', 'raw context', null, 'ea_review')
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "escalate_to_owner",
      reasoning: "The existing Codex subscription auth route is plausible and should be selectable.",
      ownerTitle: "Choose OpenAI image auth path",
      ownerContext: "Image generation needs an auth route.",
      ownerRecommendation: "Try the existing subscription route first.",
      ownerOptions: [
        {
          key: "existing-codex-subscription-auth",
          label: "Use existing Codex subscription auth",
          consequence: "Reuses an already-paid owner subscription if technically supported.",
          response: "approved",
        },
        {
          key: "new-openai-api-key",
          label: "Provide a new OpenAI API key",
          consequence: "Requires a separate credential and may add API billing.",
          response: "approved",
        },
        {
          key: "defer-image-generation",
          label: "Defer image generation",
          consequence: "Leaves image work blocked until an auth path is chosen.",
          response: "rejected",
        },
      ],
    });

    const [row] = await sql<{ options: Array<{ key: string; label: string }> }[]>`
      SELECT options FROM decisions WHERE id = ${decision.id}
    `;
    expect(row.options).toEqual([
      expect.objectContaining({ key: "existing-codex-subscription-auth" }),
      expect.objectContaining({ key: "new-openai-api-key" }),
      expect.objectContaining({ key: "defer-image-generation" }),
    ]);
  });
});

describe("decisionRequiresOwnerApproval", () => {
  it("matches explicit owner-approval phrasing", () => {
    expect(decisionTextRequiresOwnerApproval("Owner approval required")).toBe(true);
    expect(decisionTextRequiresOwnerApproval("requires owner sign-off")).toBe(true);
    expect(decisionTextRequiresOwnerApproval("owner-authored approval")).toBe(true);
    expect(decisionTextRequiresOwnerApproval("Gated by owner")).toBe(true);
    expect(decisionTextRequiresOwnerApproval("only the owner can approve")).toBe(true);
    expect(decisionTextRequiresOwnerApproval("Awaiting owner")).toBe(true);
    expect(decisionTextRequiresOwnerApproval("owner must approve before merge")).toBe(true);
    expect(decisionTextRequiresOwnerApproval("Owner Review")).toBe(true);
  });

  it("does not match unrelated decision text", () => {
    expect(decisionTextRequiresOwnerApproval(null)).toBe(false);
    expect(decisionTextRequiresOwnerApproval("")).toBe(false);
    expect(decisionTextRequiresOwnerApproval("Retry the failing task with a new role")).toBe(false);
    expect(decisionTextRequiresOwnerApproval("Cancel the orphan task and refresh metadata")).toBe(false);
    expect(decisionTextRequiresOwnerApproval("Pick a different connector path")).toBe(false);
  });

  it("scans option labels/descriptions/consequences for owner approval", () => {
    expect(
      decisionRequiresOwnerApproval({
        title: "Choose a path",
        context: "EA can decide between several technical paths.",
        options: [
          { key: "a", label: "Use existing credential" },
          { key: "b", label: "Approve and ship", description: "Requires owner approval" },
        ],
      }),
    ).toBe(true);
  });

  it("returns false when no field mentions owner approval", () => {
    expect(
      decisionRequiresOwnerApproval({
        title: "Retry with fresh credential",
        context: "The existing token expired.",
        recommendation: "Refresh and retry",
        options: [
          { key: "retry", label: "Retry now" },
          { key: "defer", label: "Defer to next pass" },
        ],
      }),
    ).toBe(false);
  });
});

describe.sequential("applyEaResolution owner-approval guard", () => {
  const HIVE_ID = "88888888-8888-8888-8888-888888888888";

  beforeEach(async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${HIVE_ID}, 'ea-resolver-owner-guard', 'EA Resolver Owner Guard', 'digital')
    `;
  });

  it("escalates to owner instead of auto-resolving when title requires owner approval", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, status)
      VALUES (
        ${HIVE_ID},
        'Owner approval required: ship release v2',
        'The release branch is ready and needs owner sign-off before merge.',
        null,
        'ea_review'
      )
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "auto_resolve",
      reasoning: "I checked the diff and it looks fine.",
    });

    const [row] = await sql<{
      status: string;
      title: string;
      context: string;
      ea_reasoning: string | null;
      resolved_by: string | null;
      resolved_at: Date | null;
    }[]>`
      SELECT status, title, context, ea_reasoning, resolved_by, resolved_at
      FROM decisions
      WHERE id = ${decision.id}
    `;
    expect(row.status).toBe("pending");
    expect(row.title).toContain("Owner approval required");
    expect(row.resolved_by).toBeNull();
    expect(row.resolved_at).toBeNull();
    expect(row.ea_reasoning).toContain("Owner-approval gate detected");
  });

  it("escalates when only an option label mentions owner approval", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, status, options)
      VALUES (
        ${HIVE_ID},
        'Pick a path forward',
        'Multiple paths are technically viable.',
        null,
        'ea_review',
        ${sql.json([
          { key: "ship", label: "Ship release", description: "Requires owner approval before merge" },
          { key: "defer", label: "Defer until next sprint" },
        ])}
      )
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "auto_resolve",
      reasoning: "Defer is fine.",
    });

    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM decisions WHERE id = ${decision.id}
    `;
    expect(row.status).toBe("pending");
  });

  it("still auto-resolves ordinary technical decisions", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, status)
      VALUES (
        ${HIVE_ID},
        'Cancel orphan task ENG-047',
        'Task was spawned by a failed sprint and never picked up.',
        'Cancel and let dispatcher recreate.',
        'ea_review'
      )
      RETURNING id
    `;

    await applyEaResolution(sql, decision.id, {
      action: "auto_resolve",
      reasoning: "Orphan task; safe to cancel.",
    });

    const [row] = await sql<{ status: string; resolved_by: string | null }[]>`
      SELECT status, resolved_by FROM decisions WHERE id = ${decision.id}
    `;
    expect(row.status).toBe("resolved");
    expect(row.resolved_by).toBe("ea-resolver");
  });
});


describe.sequential("forceEscalateAfterEaFailure", () => {
  const HIVE_ID = "99999999-9999-9999-9999-999999999999";

  beforeEach(async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${HIVE_ID}, 'ea-resolver-force-escalation', 'EA Resolver Force Escalation', 'digital')
    `;
  });

  it("shows owner-friendly fallback copy while preserving raw technical details in EA reasoning", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, title, context, recommendation, status, priority, options)
      VALUES (
        ${HIVE_ID},
        'Internal JSON parse failure: task_execution_capsules FK 23503',
        'Raw stack trace and UUID dump that should not be owner-visible.',
        'Ask the owner to debug the FK.',
        'ea_review',
        'urgent',
        ${sql.json([{ key: "debug", label: "Debug FK manually" }])}
      )
      RETURNING id
    `;

    await forceEscalateAfterEaFailure(sql, decision.id, "JSON parse failed: unexpected token");

    const [row] = await sql<{
      status: string;
      title: string;
      context: string;
      recommendation: string | null;
      priority: string;
      options: unknown;
      ea_reasoning: string | null;
    }[]>`
      SELECT status, title, context, recommendation, priority, options, ea_reasoning
      FROM decisions
      WHERE id = ${decision.id}
    `;

    expect(row.status).toBe("pending");
    expect(row.title).toBe("Decision needs manual review");
    expect(row.context).toContain("could not safely parse or complete the EA result");
    expect(row.context).not.toContain("FK 23503");
    expect(row.recommendation).toContain("Review the decision details");
    expect(row.priority).toBe("normal");
    expect(row.options).toBeNull();
    expect(row.ea_reasoning).toContain("unexpected token");
    expect(row.ea_reasoning).toContain("Internal JSON parse failure");
  });
});
