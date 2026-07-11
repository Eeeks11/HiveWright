import { beforeEach, describe, expect, it } from "vitest";
import {
  captureGoalProgress,
  claimGoalSupervisorStart,
  finalizeGoalSupervisorStart,
} from "@/goals/supervisor-start-guard";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('supervisor-start-guard', 'Supervisor Start Guard', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('guard-test-role', 'Guard Test Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status)
    VALUES (${hiveId}, 'guarded goal', 'active')
    RETURNING id
  `;
  goalId = goal.id;
});

describe("claimGoalSupervisorStart", () => {
  it("allows only one concurrent start claim", async () => {
    const [first, second] = await Promise.all([
      claimGoalSupervisorStart(sql, goalId, "session-a"),
      claimGoalSupervisorStart(sql, goalId, "session-b"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const [goal] = await sql`SELECT session_id FROM goals WHERE id = ${goalId}`;
    expect(["session-a", "session-b"]).toContain(goal.session_id);
  });

  it("does not claim terminal goals", async () => {
    await sql`UPDATE goals SET status = 'achieved' WHERE id = ${goalId}`;
    await expect(claimGoalSupervisorStart(sql, goalId, "session-a")).resolves.toBe(false);
  });
});

describe("finalizeGoalSupervisorStart", () => {
  it("rejects exit zero with no durable progress and clears only its own session for retry", async () => {
    expect(await claimGoalSupervisorStart(sql, goalId, "session-a")).toBe(true);
    const baseline = await captureGoalProgress(sql, goalId);

    const result = await finalizeGoalSupervisorStart(sql, goalId, "session-a", baseline);

    expect(result).toEqual({ progressed: false, terminal: false });
    const [goal] = await sql`SELECT status, session_id FROM goals WHERE id = ${goalId}`;
    expect(goal).toMatchObject({ status: "active", session_id: null });
    await expect(claimGoalSupervisorStart(sql, goalId, "session-b")).resolves.toBe(true);
  });

  it.each(["task", "document", "comment", "decision"] as const)(
    "accepts exit zero after a durable %s is created",
    async (kind) => {
      expect(await claimGoalSupervisorStart(sql, goalId, "session-a")).toBe(true);
      const baseline = await captureGoalProgress(sql, goalId);

      if (kind === "task") {
        await sql`INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
          VALUES (${hiveId}, 'guard-test-role', 'goal-supervisor', 'work', 'work', ${goalId})`;
      } else if (kind === "document") {
        await sql`INSERT INTO goal_documents (goal_id, document_type, title, body, created_by)
          VALUES (${goalId}, 'plan', 'plan', 'body', 'goal-supervisor')`;
      } else if (kind === "comment") {
        await sql`INSERT INTO goal_comments (goal_id, body, created_by)
          VALUES (${goalId}, 'durable acknowledgement', 'goal-supervisor')`;
      } else {
        await sql`INSERT INTO decisions (hive_id, goal_id, title, context)
          VALUES (${hiveId}, ${goalId}, 'choice', 'context')`;
      }

      await expect(finalizeGoalSupervisorStart(sql, goalId, "session-a", baseline)).resolves.toEqual({
        progressed: true,
        terminal: false,
      });
      const [goal] = await sql`SELECT session_id FROM goals WHERE id = ${goalId}`;
      expect(goal.session_id).toBe("session-a");
    },
  );

  it("accepts a terminal goal without an artifact and does not restore its session", async () => {
    expect(await claimGoalSupervisorStart(sql, goalId, "session-a")).toBe(true);
    const baseline = await captureGoalProgress(sql, goalId);
    await sql`UPDATE goals SET status = 'achieved', session_id = NULL WHERE id = ${goalId}`;

    await expect(finalizeGoalSupervisorStart(sql, goalId, "session-a", baseline)).resolves.toEqual({
      progressed: true,
      terminal: true,
    });
  });

  it("does not clear a replacement session when a stale starter reports no progress", async () => {
    expect(await claimGoalSupervisorStart(sql, goalId, "session-a")).toBe(true);
    const baseline = await captureGoalProgress(sql, goalId);
    await sql`UPDATE goals SET session_id = 'session-b' WHERE id = ${goalId}`;

    await finalizeGoalSupervisorStart(sql, goalId, "session-a", baseline);

    const [goal] = await sql`SELECT session_id FROM goals WHERE id = ${goalId}`;
    expect(goal.session_id).toBe("session-b");
  });
});
