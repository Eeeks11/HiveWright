import * as fs from "fs";
import * as path from "path";
import { buildAgentEnvironmentLifecycleConfig } from "./agent-environment-lifecycle";

const RUNTIME_ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

const BOUNDARY_OWNED_KEYS = new Set([
  ...RUNTIME_ENV_ALLOWLIST,
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "HIVEWRIGHT_TASK_ID",
  "HIVEWRIGHT_HIVE_ID",
  "HIVEWRIGHT_GOAL_ID",
  "HIVEWRIGHT_SUPERVISOR_SESSION",
]);

export type AgentEnvironmentScope =
  | { kind: "task"; adapter: string; taskId: string; hiveId: string }
  | { kind: "probe"; adapter: string; model: string }
  | {
      kind: "goal-supervisor";
      adapter: string;
      goalId: string;
      hiveId: string;
      supervisorSession: string;
    };

export interface BuildAgentEnvironmentInput {
  /** Parent environment is read only for the small runtime allowlist above. */
  ambientEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Values returned by the existing hive/role-scoped credential loader. */
  credentials?: Record<string, string | undefined>;
  /** Non-secret adapter flags such as GEMINI_CLI_TRUST_WORKSPACE. */
  adapterEnv?: Record<string, string | undefined>;
  scope: AgentEnvironmentScope;
  runtimeRoot?: string;
  /** Native CLI state required for subscription auth; linked under scoped HOME. */
  nativeProviderState?: string[];
}

/**
 * Construct an untrusted-workload environment from an empty object.
 *
 * Unknown ambient variables are denied by construction. Credential names are
 * deliberately not guessed or filtered: every credential passed here was
 * explicitly selected by the hive/role-scoped loader. Boundary-owned runtime
 * and identity keys cannot be replaced by a credential row.
 */
export function buildAgentEnvironment(input: BuildAgentEnvironmentInput): NodeJS.ProcessEnv {
  const ambient = input.ambientEnv ?? process.env;
  const defaultRuntimeRoot = ambient.HIVEWRIGHT_RUNTIME_ROOT
    ? path.join(ambient.HIVEWRIGHT_RUNTIME_ROOT, "agent-environments")
    : path.join(process.cwd(), ".hivewright-agent-runtime");
  const runtimeRoot = path.resolve(input.runtimeRoot ?? defaultRuntimeRoot);
  const scopeName = scopeDirectoryName(input.scope);
  const scopeRoot = path.join(runtimeRoot, scopeName);
  const home = path.join(scopeRoot, "home");
  const tmp = path.join(scopeRoot, "tmp");

  ensurePrivateDirectory(runtimeRoot);
  ensurePrivateDirectory(scopeRoot);
  ensurePrivateDirectory(home);
  ensurePrivateDirectory(tmp);
  ensurePrivateDirectory(path.join(home, ".config"));
  ensurePrivateDirectory(path.join(home, ".cache"));
  ensurePrivateDirectory(path.join(home, ".local", "share"));
  linkNativeProviderState(home, ambient.HOME, input.nativeProviderState ?? []);

  const env: Record<string, string> = {};
  for (const key of RUNTIME_ENV_ALLOWLIST) {
    const value = ambient[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  env.PATH ||= "/usr/local/bin:/usr/bin:/bin";
  env.HOME = home;
  env.TMPDIR = tmp;
  env.TMP = tmp;
  env.TEMP = tmp;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");

  Object.assign(env, buildAgentEnvironmentLifecycleConfig({ runtimeRoot }).buildSharedCacheEnv());

  copyExplicitValues(env, input.credentials);
  copyExplicitValues(env, input.adapterEnv);

  if (input.scope.kind === "task") {
    env.HIVEWRIGHT_TASK_ID = input.scope.taskId;
    env.HIVEWRIGHT_HIVE_ID = input.scope.hiveId;
  } else if (input.scope.kind === "goal-supervisor") {
    env.HIVEWRIGHT_GOAL_ID = input.scope.goalId;
    env.HIVEWRIGHT_HIVE_ID = input.scope.hiveId;
    env.HIVEWRIGHT_SUPERVISOR_SESSION = input.scope.supervisorSession;
  }

  return env as NodeJS.ProcessEnv;
}

function copyExplicitValues(
  destination: Record<string, string>,
  values: Record<string, string | undefined> | undefined,
): void {
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === undefined || BOUNDARY_OWNED_KEYS.has(key)) continue;
    destination[key] = value;
  }
}

function scopeDirectoryName(scope: AgentEnvironmentScope): string {
  if (scope.kind === "task") return `task-${safeSegment(scope.taskId)}--${safeSegment(scope.adapter)}`;
  if (scope.kind === "goal-supervisor") return `goal-${safeSegment(scope.goalId)}--${safeSegment(scope.adapter)}`;
  return `probe-${safeSegment(scope.adapter)}--${safeSegment(scope.model)}`;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (safe || "unknown").slice(0, 160);
}

function ensurePrivateDirectory(directory: string): void {
  try {
    const existing = fs.lstatSync(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Agent runtime path must be a real directory: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

function linkNativeProviderState(scopedHome: string, nativeHome: string | undefined, entries: string[]): void {
  if (!nativeHome) return;
  for (const entry of entries) {
    if (!entry.startsWith(".") || entry.includes("/") || entry.includes("\\")) {
      throw new Error(`Invalid native provider state entry: ${entry}`);
    }
    const destination = path.join(scopedHome, entry);
    if (fs.existsSync(destination) || isSymlink(destination)) continue;
    fs.symlinkSync(path.join(nativeHome, entry), destination);
  }
}

function isSymlink(candidate: string): boolean {
  try { return fs.lstatSync(candidate).isSymbolicLink(); } catch { return false; }
}
