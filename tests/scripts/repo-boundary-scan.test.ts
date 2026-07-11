import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const scannerPath = path.join(repoRoot, "scripts/repo-boundary-scan.ts");
const tsxBin = path.join(repoRoot, "node_modules/.bin/tsx");
const tempRepos: string[] = [];

function makeBoundaryRepo() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "hivewright-boundary-scan-"));
  tempRepos.push(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
  writeFileSync(path.join(repo, ".gitignore"), [
    ".env",
    "artifacts/",
    "docs/qa/",
    "docs/superpowers/plans/",
    "docs/security/",
    "planning/",
    "CLAUDE.md",
    ".claude/",
    ".codex/",
    ".hermes/",
    ".openclaw/",
    ".superpowers/",
    "",
  ].join("\n"));
  writeFileSync(path.join(repo, ".env.example"), "DATABASE_URL=postgres://example\n");
  writeFileSync(path.join(repo, "README.md"), "# Clean public source\n");
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  writeFileSync(path.join(repo, "docs/installation.md"), "# Installation\n");
  spawnSync("git", ["add", "."], { cwd: repo, encoding: "utf8" });
  return repo;
}

function runBoundaryScan(repo: string) {
  return spawnSync(tsxBin, [scannerPath], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 5,
  });
}

describe("repo boundary scan", () => {
  afterEach(() => {
    for (const repo of tempRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  it("passes a clean tracked public source tree", () => {
    const repo = makeBoundaryRepo();

    const result = runBoundaryScan(repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Repository boundary scan passed.");
    expect(result.stderr).toBe("");
  });

  it("fails when a tracked source file contains a real private operator home path", () => {
    const repo = makeBoundaryRepo();
    const privateHome = ["/home", "trent"].join("/");
    writeFileSync(path.join(repo, "README.md"), `Do not publish ${privateHome}/apps/HiveWright\n`);
    spawnSync("git", ["add", "README.md"], { cwd: repo, encoding: "utf8" });

    const result = runBoundaryScan(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Repository boundary scan failed with 1 finding(s):");
    expect(result.stderr).toContain("[private-marker] README.md:1 - Found private home path");
    expect(result.stderr).toContain(privateHome);
  });
});
