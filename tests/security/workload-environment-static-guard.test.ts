import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

const WORKLOAD_MODULES = [
  "src/adapters/codex.ts",
  "src/adapters/claude-code.ts",
  "src/adapters/gemini.ts",
  "src/adapters/openclaw.ts",
  "src/goals/supervisor-codex.ts",
  "src/goals/supervisor-env.ts",
  "src/goals/supervisor-openclaw.ts",
];

describe("workload environment static guard", () => {
  it.each(WORKLOAD_MODULES)("%s cannot spread or pass ambient process.env", async (relativePath) => {
    const source = await readFile(path.join(process.cwd(), relativePath), "utf8");
    expect(source).not.toMatch(/\.\.\.\s*process\.env/);
    expect(source).not.toMatch(/env\s*:\s*process\.env/);
    expect(source).toMatch(/buildAgentEnvironment|buildGoalSupervisorProcessEnv/);
  });
});
