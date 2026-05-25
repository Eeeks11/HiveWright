import { describe, expect, it, vi } from "vitest";
import { runBusinessRestartSurvivalProof } from "../../scripts/readiness/business-restart-survival-proof";

const HIVE_ID = "b6b815ba-5109-4066-8a33-cc5560d3a0e1";

function createSql() {
  return vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM tasks") && query.includes("dispatcher_pid") && query.includes("ORDER BY started_at")) {
      return Promise.resolve([{
        id: "task-1",
        title: "[restart-survival-proof] interrupted task",
        assignedTo: "operator",
        dispatcherPid: 999999,
      }]);
    }
    if (query.includes("UPDATE tasks") && query.includes("Interrupted by dispatcher lifecycle recovery")) {
      return Promise.resolve([]);
    }
    if (query.includes("proof_tasks")) {
      return Promise.resolve([{
        active_stale_tasks: 0,
        final_work_products: 1,
        owner_openable_deliverables: 1,
        completion_evidence_references_deliverable: true,
        cross_hive_rows: 0,
      }]);
    }
    return Promise.resolve([]);
  });
}

describe("business restart survival proof", () => {
  it("uses dispatcher lifecycle recovery and verifies owner-openable completion evidence", async () => {
    const sql = createSql();

    const result = await runBusinessRestartSurvivalProof(sql as never, {
      hiveId: HIVE_ID,
      currentPid: 123,
      interruptedPid: 999999,
      pidAlive: () => false,
    });

    expect(result).toEqual({
      recoveredInterruptedTasks: 1,
      staleActiveCleared: true,
      finalWorkProductExists: true,
      ownerOpenableDeliverable: true,
      completionEvidenceReferencesDeliverable: true,
      isolatedToProofHive: true,
    });
    const queries = sql.mock.calls.map((call) => call[0].join("?"));
    expect(queries.some((query) => query.includes("UPDATE tasks"))).toBe(true);
    expect(queries.some((query) => query.includes("goal_completions"))).toBe(true);
  });

  it("fails proof when final deliverable is not owner-openable", async () => {
    const sql = vi.fn((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("FROM tasks") && query.includes("ORDER BY started_at")) return Promise.resolve([]);
      if (query.includes("proof_tasks")) {
        return Promise.resolve([{
          active_stale_tasks: 1,
          final_work_products: 1,
          owner_openable_deliverables: 0,
          completion_evidence_references_deliverable: false,
          cross_hive_rows: 0,
        }]);
      }
      return Promise.resolve([]);
    });

    const result = await runBusinessRestartSurvivalProof(sql as never, {
      hiveId: HIVE_ID,
      currentPid: 123,
    });

    expect(result.staleActiveCleared).toBe(false);
    expect(result.finalWorkProductExists).toBe(true);
    expect(result.ownerOpenableDeliverable).toBe(false);
    expect(result.completionEvidenceReferencesDeliverable).toBe(false);
  });
});
