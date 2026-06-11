import { describe, expect, it } from "vitest";
import { verifyLandedState } from "../../src/software-pipeline/landed-state-gate";

describe("verifyLandedState", () => {
  it("accepts a clean main worktree containing the expected commit", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: ["abc123"],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "main\n";
        if (args.join(" ") === "status --porcelain") return "";
        if (args.join(" ") === "merge-base --is-ancestor abc123 HEAD") return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("accepts a clean detached runtime checkout pinned to origin/main", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: ["abc123"],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "\n";
        if (args.join(" ") === "rev-parse HEAD") return "deadbeef\n";
        if (args.join(" ") === "rev-parse origin/main") return "deadbeef\n";
        if (args.join(" ") === "status --porcelain") return "";
        if (args.join(" ") === "merge-base --is-ancestor abc123 HEAD") return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when verification is run from a task branch instead of main", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: [],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "hw/task/example-dev-agent\n";
        if (args.join(" ") === "status --porcelain") return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Expected current branch main, got hw/task/example-dev-agent.");
  });

  it("fails when a detached runtime checkout is not pinned to origin/main", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: [],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "\n";
        if (args.join(" ") === "rev-parse HEAD") return "deadbeef\n";
        if (args.join(" ") === "rev-parse origin/main") return "feedface\n";
        if (args.join(" ") === "status --porcelain") return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      "Expected current branch main, got (detached HEAD) not pinned to origin/main.",
    );
  });

  it("fails when the required work commit is not landed on the current branch", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: ["2ac34ff"],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "main\n";
        if (args.join(" ") === "status --porcelain") return "";
        if (args.join(" ") === "merge-base --is-ancestor 2ac34ff HEAD") {
          throw Object.assign(new Error("not ancestor"), { status: 1 });
        }
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Required commit 2ac34ff is not an ancestor of HEAD.");
  });

  it("fails when the worktree is dirty even if the detached runtime checkout matches origin/main", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: [],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "\n";
        if (args.join(" ") === "rev-parse HEAD") return "deadbeef\n";
        if (args.join(" ") === "rev-parse origin/main") return "deadbeef\n";
        if (args.join(" ") === "status --porcelain") return " M src/file.ts\n";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Expected a clean working tree before completion.");
  });
});
