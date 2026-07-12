import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex CLI runtime compatibility", () => {
  it("pins the transitive Codex CLI to the GPT-5.6-compatible release", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

    expect(packageJson.overrides?.["@openai/codex"]).toBe("0.144.1");
    expect(packageLock.packages?.["node_modules/@openai/codex"]?.version).toBe("0.144.1");
    expect(packageLock.packages?.["node_modules/@openai/codex-linux-x64"]?.version)
      .toBe("0.144.1-linux-x64");
  });
});
