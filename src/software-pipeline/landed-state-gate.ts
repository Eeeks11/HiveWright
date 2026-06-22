export type GitRunner = (args: string[]) => Promise<string>;

export type LandedStateGateInput = {
  expectedBranch?: string;
  requiredAncestors?: string[];
  git?: GitRunner;
};

export type LandedStateGateResult = {
  ok: boolean;
  failures: string[];
};

export async function verifyLandedState(input: LandedStateGateInput = {}): Promise<LandedStateGateResult> {
  const expectedBranch = input.expectedBranch ?? "main";
  const requiredAncestors = input.requiredAncestors ?? [];
  const git = input.git ?? runGit;
  const failures: string[] = [];

  const currentBranch = (await git(["branch", "--show-current"])).trim();
  if (currentBranch !== expectedBranch) {
    if (currentBranch.length === 0) {
      const expectedRemoteRef = `origin/${expectedBranch}`;
      const headCommit = (await git(["rev-parse", "HEAD"])).trim();

      try {
        const expectedRemoteCommit = (await git(["rev-parse", expectedRemoteRef])).trim();
        if (headCommit !== expectedRemoteCommit) {
          failures.push(`Expected current branch ${expectedBranch}, got (detached HEAD) not pinned to ${expectedRemoteRef}.`);
        }
      } catch {
        failures.push(`Expected current branch ${expectedBranch}, got (detached HEAD) and could not resolve origin/${expectedBranch}.`);
      }
    } else {
      failures.push(`Expected current branch ${expectedBranch}, got ${currentBranch}.`);
    }
  }

  const status = (await git(["status", "--porcelain"])).trim();
  if (status.length > 0) {
    failures.push("Expected a clean working tree before completion.");
  }

  for (const commit of requiredAncestors) {
    try {
      await git(["merge-base", "--is-ancestor", commit, "HEAD"]);
    } catch {
      failures.push(`Required commit ${commit} is not an ancestor of HEAD.`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

async function runGit(args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("git", args);
  return stdout;
}
