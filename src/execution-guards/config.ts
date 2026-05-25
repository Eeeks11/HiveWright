import type { RuntimeLoopGuardConfig, RuntimeGuardMode } from "./types";

export const DEFAULT_LOOP_GUARD_CONFIG: RuntimeLoopGuardConfig = {
  mode: "enforce",
  warnThreshold: 3,
  hardLimit: 5,
  windowSize: 20,
  toolFrequencyWarn: 30,
  toolFrequencyHardLimit: 50,
};

export function parseLoopGuardConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeLoopGuardConfig {
  const mode = parseMode(env.HIVEWRIGHT_LOOP_GUARD_MODE);
  return {
    mode,
    warnThreshold: parsePositiveInteger(
      env.HIVEWRIGHT_LOOP_WARN_THRESHOLD,
      DEFAULT_LOOP_GUARD_CONFIG.warnThreshold,
    ),
    hardLimit: parsePositiveInteger(
      env.HIVEWRIGHT_LOOP_HARD_LIMIT,
      DEFAULT_LOOP_GUARD_CONFIG.hardLimit,
    ),
    windowSize: parsePositiveInteger(
      env.HIVEWRIGHT_LOOP_WINDOW_SIZE,
      DEFAULT_LOOP_GUARD_CONFIG.windowSize,
    ),
    toolFrequencyWarn: parsePositiveInteger(
      env.HIVEWRIGHT_LOOP_TOOL_FREQ_WARN,
      DEFAULT_LOOP_GUARD_CONFIG.toolFrequencyWarn,
    ),
    toolFrequencyHardLimit: parsePositiveInteger(
      env.HIVEWRIGHT_LOOP_TOOL_FREQ_HARD_LIMIT,
      DEFAULT_LOOP_GUARD_CONFIG.toolFrequencyHardLimit,
    ),
  };
}

function parseMode(value: string | undefined): RuntimeGuardMode {
  if (value === "off" || value === "diagnostic" || value === "enforce") {
    return value;
  }
  return DEFAULT_LOOP_GUARD_CONFIG.mode;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
