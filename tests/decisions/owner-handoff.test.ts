import { describe, it, expect, beforeEach } from "vitest";
import { detectOwnerHandoffSignal, ensureOwnerHandoffDecision } from "@/decisions/owner-handoff";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let goalId: string;
let taskId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('owner-handoff-test', 'Owner Handoff Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, description, status)
    VALUES (${hiveId}, 'Investment stack', 'Test goal', 'active')
    RETURNING id
  `;
  goalId = goal.id;
  const [task] = await sql`
    INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
    VALUES (${hiveId}, ${goalId}, 'financial-analyst', 'dispatcher', 'Prepare owner package', 'brief', 'completed')
    RETURNING id
  `;
  taskId = task.id;
});

describe("detectOwnerHandoffSignal", () => {
  it("detects completed work products that explicitly need Trent to choose a path", () => {
    const signal = detectOwnerHandoffSignal(
      [
        "**Blocker**",
        "- No owner response was found.",
        "- Trent still needs to choose one path: remain generic education only, supply data for a future gate rerun, or pursue licensed financial-advice review.",
      ].join("\n"),
      "Sprint 4 handoff",
    );

    expect(signal?.needsOwner).toBe(true);
    expect(signal?.title).toBe("Choose how the investing hive should proceed");
    expect(signal?.context).toContain("cannot continue safely");
    expect(signal?.options.map((option) => option.key)).toEqual([
      "generic_education_only",
      "supply_data_for_gate_rerun",
      "licensed_advice_review",
    ]);
  });

  it("ignores ordinary completed deliverables with no owner ask", () => {
    const signal = detectOwnerHandoffSignal("Outcome: report completed. QA passed.", "Report");
    expect(signal).toBeNull();
  });
});

describe("ensureOwnerHandoffDecision", () => {
  it("creates one EA-review decision instead of leaving the ask buried in the artifact", async () => {
    const result = await ensureOwnerHandoffDecision(sql, {
      hiveId,
      goalId,
      taskId,
      taskTitle: "Sprint 4: Handoff model-only package",
      notify: false,
      deliverable: [
        "Owner response status recorded as `NO_RESPONSE_RECORDED`.",
        "Trent still needs to choose one path: remain generic education only, supply data for a future gate rerun, or pursue licensed financial-advice review.",
      ].join("\n"),
    });

    expect(result.created).toBe(true);
    expect(result.decisionId).toBeDefined();
    const decisionId = result.decisionId as string;
    const [decision] = await sql`
      SELECT status, kind, title, context, recommendation, route_metadata, options, ea_reasoning
      FROM decisions
      WHERE id = ${decisionId}
    `;
    expect(decision.status).toBe("ea_review");
    expect(decision.kind).toBe("decision");
    expect(decision.title).toBe("Choose how the investing hive should proceed");
    expect(decision.context).toContain("cannot continue safely");
    expect(decision.context).not.toContain("NO_RESPONSE_RECORDED");
    expect(decision.recommendation).toContain("compliance risk");
    expect(decision.route_metadata.source).toBe("owner_handoff");
    expect(decision.route_metadata.inputType).toBe("choose_option");
    expect(decision.route_metadata.rawHiveRequest).toContain("NO_RESPONSE_RECORDED");
    expect(decision.ea_reasoning).toContain("Raw hive request preserved");
    expect(decision.options).toHaveLength(3);
    const messages = await sql`SELECT sender, content FROM decision_messages WHERE decision_id = ${decisionId}`;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("EA review is required");
  });

  it("dedupes unresolved owner handoff decisions for the same task", async () => {
    const input = {
      hiveId,
      goalId,
      taskId,
      taskTitle: "Sprint 4: Handoff model-only package",
      notify: false,
      deliverable: "Owner Decisions Still Required: Trent must choose generic education only or licensed advice review.",
    };
    const first = await ensureOwnerHandoffDecision(sql, input);
    const second = await ensureOwnerHandoffDecision(sql, input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.decisionId).toBe(first.decisionId);
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM decisions WHERE task_id = ${taskId}`;
    expect(count).toBe(1);
  });
});
