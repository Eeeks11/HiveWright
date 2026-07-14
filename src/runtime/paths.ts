import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const HIVEWRIGHT_RUNTIME_ROOT_ENV = "HIVEWRIGHT_RUNTIME_ROOT";
export const HIVEWRIGHT_ENV_FILE_ENV = "HIVEWRIGHT_ENV_FILE";

export interface RuntimeHomeResolutionOptions {
  osHomeDir?: string;
  userHomeDir?: string;
  runtimeRootExists?: (runtimeRoot: string) => boolean;
  cwd?: string;
}

export function pathContains(childPath: string, parentPath: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertOutsideRepo(pathname: string, repoRoot = process.cwd(), label = "Runtime path"): string {
  const resolved = path.resolve(pathname);
  const resolvedRepo = path.resolve(repoRoot);

  if (pathContains(resolved, resolvedRepo)) {
    throw new Error(
      `${label} must be outside the HiveWright software repository. Set ${HIVEWRIGHT_RUNTIME_ROOT_ENV} to an external directory.`,
    );
  }

  return resolved;
}

function safeUserHomeDir(): string | null {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

export function resolveDefaultRuntimeHome(
  env: { [key: string]: string | undefined } = process.env,
  options: RuntimeHomeResolutionOptions = {},
): string {
  const envHome = env.HOME?.trim();
  const userHomeDir = options.userHomeDir ?? safeUserHomeDir();
  const osHomeDir = options.osHomeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const runtimeRootExists = options.runtimeRootExists ?? ((candidate: string) => fs.existsSync(candidate));

  const candidates = [envHome, userHomeDir, osHomeDir]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    .map((candidate) => path.resolve(candidate));

  const uniqueCandidates = Array.from(new Set(candidates));
  for (const candidate of uniqueCandidates) {
    if (runtimeRootExists(path.join(candidate, ".hivewright"))) {
      return candidate;
    }
  }

  return uniqueCandidates[0] ?? cwd;
}

export function resolveHivewrightRuntimeRoot(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
  options: RuntimeHomeResolutionOptions = {},
): string {
  const configured = env[HIVEWRIGHT_RUNTIME_ROOT_ENV];
  const defaultRoot = path.join(resolveDefaultRuntimeHome(env, options), ".hivewright");
  return assertOutsideRepo(configured ?? defaultRoot, repoRoot, "HiveWright runtime root");
}

export function resolveRuntimePath(
  segments: string[],
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
  options: RuntimeHomeResolutionOptions = {},
): string {
  const runtimeRoot = resolveHivewrightRuntimeRoot(env, repoRoot, options);
  return assertOutsideRepo(path.join(runtimeRoot, ...segments), repoRoot, "HiveWright runtime path");
}

export function resolveHivewrightEnvFilePath(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = process.cwd(),
  options: RuntimeHomeResolutionOptions = {},
): string {
  const configured = env[HIVEWRIGHT_ENV_FILE_ENV];
  if (configured) return assertOutsideRepo(configured, repoRoot, "HiveWright env file");
  return resolveRuntimePath(["config", ".env"], env, repoRoot, options);
}
