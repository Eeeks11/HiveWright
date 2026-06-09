import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface HiveWrightBuildProvenance {
  version: string | null;
  versionSource: string | null;
  buildHash: string | null;
  buildHashSource: string | null;
  gitCommit: string | null;
  gitCommitSource: string | null;
  source: "env" | "package" | "git" | "mixed" | "unknown";
  capturedAt: string;
}

export interface ResolveHiveWrightBuildProvenanceInput {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  repoRoot?: string;
  execGit?: boolean;
}

const BUILD_HASH_ENV_KEYS = [
  "VERCEL_GIT_COMMIT_SHA",
  "HIVEWRIGHT_BUILD_HASH",
  "HIVEWRIGHT_BUILD_SHA",
  "GITHUB_SHA",
  "SOURCE_VERSION",
  "COMMIT_SHA",
] as const;

export function resolveHiveWrightBuildProvenance(
  input: ResolveHiveWrightBuildProvenanceInput = {},
): HiveWrightBuildProvenance {
  const env = input.env ?? process.env;
  const repoRoot = input.repoRoot ?? process.cwd();
  const capturedAt = (input.now ?? new Date()).toISOString();

  const envVersion = nonEmpty(env.npm_package_version) ?? nonEmpty(env.HIVEWRIGHT_VERSION);
  const packageVersion = envVersion ? null : readPackageVersion(repoRoot);
  const version = envVersion ?? packageVersion ?? null;
  const versionSource = envVersion ? "env" : packageVersion ? "package.json" : null;

  const envBuildHash = firstEnvValue(env, BUILD_HASH_ENV_KEYS);
  const gitCommit = envBuildHash.value ?? readGitCommit(repoRoot, input.execGit ?? true);
  const gitCommitSource = envBuildHash.value ? envBuildHash.key : gitCommit ? "git rev-parse HEAD" : null;
  const buildHash = envBuildHash.value ?? gitCommit ?? null;
  const buildHashSource = envBuildHash.value ? envBuildHash.key : gitCommit ? "git rev-parse HEAD" : null;

  return {
    version,
    versionSource,
    buildHash,
    buildHashSource,
    gitCommit,
    gitCommitSource,
    source: classifySource({ versionSource, buildHashSource }),
    capturedAt,
  };
}

function firstEnvValue(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { key: string | null; value: string | null } {
  for (const key of keys) {
    const value = nonEmpty(env[key]);
    if (value) return { key, value };
  }
  return { key: null, value: null };
}

function readPackageVersion(repoRoot: string): string | null {
  try {
    const packagePath = path.join(repoRoot, "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function readGitCommit(repoRoot: string, execGit: boolean): string | null {
  if (!execGit) return null;
  try {
    const output = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return nonEmpty(output);
  } catch {
    return null;
  }
}

function classifySource(input: { versionSource: string | null; buildHashSource: string | null }): HiveWrightBuildProvenance["source"] {
  const sources = new Set(
    [input.versionSource, input.buildHashSource]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.startsWith("git ") ? "git" : value === "package.json" ? "package" : "env"),
  );
  if (sources.size === 0) return "unknown";
  if (sources.size === 1) return Array.from(sources)[0] as HiveWrightBuildProvenance["source"];
  return "mixed";
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
