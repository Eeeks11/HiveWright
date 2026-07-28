import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { readLatestCodexEmptyOutputDiagnostic } from "@/runtime-diagnostics/codex-empty-output";

function sqlShouldNotRun(): Sql {
  return vi.fn(() => {
    throw new Error("sql should not be called for synthetic non-UUID task ids");
  }) as unknown as Sql;
}

describe("readLatestCodexEmptyOutputDiagnostic", () => {
  it("skips UUID-backed diagnostic log queries for synthetic non-task ids", async () => {
    await expect(
      readLatestCodexEmptyOutputDiagnostic(sqlShouldNotRun(), "llm-release-scan-websearch"),
    ).resolves.toBeNull();
  });
});
