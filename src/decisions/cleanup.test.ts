import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAgentAuditEvent: vi.fn(),
}));

vi.mock("@/audit/agent-events", () => ({
  AGENT_AUDIT_EVENTS: {
    decisionArchived: "decision.archived",
  },
  recordAgentAuditEvent: mocks.recordAgentAuditEvent,
}));

import { reconcileDecisionIntegrity } from "./cleanup";

type SqlCall = {
  text: string;
  values: unknown[];
};

function createSqlMock(responses: unknown[][]) {
  const calls: SqlCall[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({
      text: strings.join("?"),
      values,
    });
    return responses.shift() ?? [];
  }) as unknown as Sql;
  const sqlWithTestState = sql as unknown as {
    unsafe: ReturnType<typeof vi.fn>;
    calls: SqlCall[];
  };

  sqlWithTestState.unsafe = vi.fn((value: string) => `/* unsafe:${value} */`);
  sqlWithTestState.calls = calls;
  return sql as Sql & { calls: SqlCall[] };
}

describe("decision cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps stale internal cleanup goal-scoped during goal reconciliation", async () => {
    const sql = createSqlMock([
      [],
      [],
      [],
    ]);
    const now = new Date("2026-06-01T00:00:00.000Z");

    await reconcileDecisionIntegrity(sql, {
      now,
      olderThanDays: 14,
      hiveId: "11111111-1111-1111-1111-111111111111",
      goalId: "22222222-2222-2222-2222-222222222222",
      limit: 50,
    });

    const staleInternalSweep = sql.calls[0];
    expect(staleInternalSweep.text).toContain("d.goal_id");
    expect(staleInternalSweep.text).toContain("d.goal_id = ?::uuid");
    expect(
      staleInternalSweep.values.filter((value) => value === "22222222-2222-2222-2222-222222222222"),
    ).toHaveLength(2);
    expect(staleInternalSweep.values).toContain("11111111-1111-1111-1111-111111111111");

    expect(mocks.recordAgentAuditEvent).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        goalId: "22222222-2222-2222-2222-222222222222",
        hiveId: "11111111-1111-1111-1111-111111111111",
        metadata: expect.objectContaining({
          source: "stale_internal_decision_cleanup",
          goalId: "22222222-2222-2222-2222-222222222222",
          hiveId: "11111111-1111-1111-1111-111111111111",
        }),
      }),
    );
  });
});
