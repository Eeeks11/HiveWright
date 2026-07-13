import * as path from "node:path";
import { resolveHivewrightRuntimeRoot } from "@/runtime/paths";

type EnvLike = Record<string, string | undefined>;

export function resolveUpdateLogDirectory(env: EnvLike = process.env): string {
  const runtimeRoot = resolveHivewrightRuntimeRoot(env);
  return path.join(runtimeRoot, "logs", "updates");
}
