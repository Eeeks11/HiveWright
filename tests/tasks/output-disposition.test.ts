import { describe, expect, it } from "vitest";
import {
  QA_NO_FOLLOW_UP_TERMINAL_DISPOSITION_LINE,
  buildQaOutputDispositionInstructions,
  buildTaskOutputDispositionInstructions,
  ensureQaNoFollowUpTerminalDispositionLine,
  hasTerminalDispositionLine,
  taskRequiresOutputDisposition,
} from "@/tasks/output-disposition";

describe("output disposition instruction builders", () => {
  it("detects explicit terminal disposition closeout contracts", () => {
    expect(taskRequiresOutputDisposition({
      title: "routing-closeout",
      brief: "Review this routing/publication closeout. The final result must end with exactly one terminal disposition line using a concrete GitHub issue/PR route or Deliberate no-follow-up terminal disposition.",
      acceptanceCriteria: "Result must include the canonical closeout line.",
    })).toBe(true);
  });

  it("does not require terminal disposition for ordinary work", () => {
    expect(taskRequiresOutputDisposition({
      title: "ordinary-work",
      brief: "Build thing",
      acceptanceCriteria: "It must work.",
    })).toBe(false);
  });

  it("renders task and QA disposition instructions with canonical prefixes", () => {
    expect(buildTaskOutputDispositionInstructions()).toContain("GitHub issue/PR route:");
    const block = buildQaOutputDispositionInstructions();
    expect(block).toContain(QA_NO_FOLLOW_UP_TERMINAL_DISPOSITION_LINE);
    expect(block).toContain("QA review is terminal");
  });

  it("appends the canonical QA terminal disposition when missing", () => {
    const output = "pass\n\nAll reviewed evidence meets the task acceptance criteria.";

    const prepared = ensureQaNoFollowUpTerminalDispositionLine(output);

    expect(prepared).toBe(`${output}\n\n${QA_NO_FOLLOW_UP_TERMINAL_DISPOSITION_LINE}`);
    expect(hasTerminalDispositionLine(prepared)).toBe(true);
  });

  it("does not duplicate an existing terminal disposition line", () => {
    const output = [
      "pass",
      "",
      "No blocking issues found.",
      QA_NO_FOLLOW_UP_TERMINAL_DISPOSITION_LINE,
    ].join("\n");

    expect(ensureQaNoFollowUpTerminalDispositionLine(output)).toBe(output);
  });

  it("preserves an existing GitHub issue or PR route disposition", () => {
    const output = "pass\n\nGitHub issue/PR route: #123";

    expect(hasTerminalDispositionLine(output)).toBe(true);
    expect(ensureQaNoFollowUpTerminalDispositionLine(output)).toBe(output);
  });
});
