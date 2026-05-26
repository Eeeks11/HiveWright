import * as path from "node:path";

type EnvLike = Record<string, string | undefined>;

export function resolveUpdateLogDirectory(env: EnvLike = process.env): string {
  const runtimeRoot = env.HIVEWRIGHT_RUNTIME_ROOT || path.join(env.HOME || process.cwd(), ".hivewright");
  return path.join(runtimeRoot, "logs", "updates");
}
