import { describe, expect, it } from "vitest";
import { evaluateDeploymentSensitiveCompletionEvidence } from "@/software-pipeline/deployment-sensitive-proof";

describe("deployment-sensitive completion proof", () => {
  it("treats ordinary git-repo worktree verification as optional when no live deployment is claimed", () => {
    const result = evaluateDeploymentSensitiveCompletionEvidence({
      projectGitRepo: true,
      taskTitle: "Refactor helper module",
      taskBrief: "Improve the parser and run focused tests.",
      resultSummary: "Focused tests passed in task worktree at commit 36cb96c.",
      currentRuntimeBuildHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.required).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("blocks deployment-sensitive completion when only task-worktree proof is present", () => {
    const result = evaluateDeploymentSensitiveCompletionEvidence({
      projectGitRepo: true,
      taskTitle: "Deploy runtime fix",
      taskBrief: "Restart service after the fix is live in the operational checkout.",
      resultSummary: "Expected commit 36cb96c passed QA in the task worktree. npm test passed.",
      currentRuntimeBuildHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.required).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("task-worktree QA alone is not live proof");
    expect(result.failures.join("\n")).toContain("Current runtime build hash");
  });

  it("accepts deployment-sensitive completion only when expected, live, and current runtime hashes match", () => {
    const result = evaluateDeploymentSensitiveCompletionEvidence({
      projectGitRepo: true,
      taskTitle: "Deploy runtime fix",
      taskBrief: "Deployment requires same-build live proof.",
      resultSummary: [
        "Expected commit: 36cb96c",
        "Passed in task worktree: npm test -- tests/dispatcher/task-claimer.test.ts",
        "Operational live build hash: 36cb96c0ffeed00d1234567890abcdef12345678",
      ].join("\n"),
      currentRuntimeBuildHash: "36cb96c0ffeed00d1234567890abcdef12345678",
    });

    expect(result.required).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.expectedCommit).toBe("36cb96c");
    expect(result.liveBuildHash).toBe("36cb96c0ffeed00d1234567890abcdef12345678");
    expect(result.failures).toEqual([]);
  });
});
