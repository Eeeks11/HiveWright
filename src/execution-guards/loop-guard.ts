import { parseLoopGuardConfig } from "./config";
import { RuntimeLoopDetector } from "./loop-detector";
import { RuntimeGuardPipeline } from "./guard-pipeline";
import type {
  RuntimeGuard,
  RuntimeGuardDecision,
  RuntimeLoopGuardConfig,
} from "./types";

export function createRuntimeLoopGuard(
  config: Partial<RuntimeLoopGuardConfig> = {},
): RuntimeGuard {
  const detector = new RuntimeLoopDetector(config);
  return {
    name: "runtime_loop_guard",
    observe: (event) => detector.observe(event),
    reset: () => detector.reset(),
  };
}

export function createDefaultRuntimeGuardPipeline(options: {
  env?: Record<string, string | undefined>;
  onDecision?: (decision: RuntimeGuardDecision) => Promise<void> | void;
} = {}): RuntimeGuardPipeline {
  const config = parseLoopGuardConfig(options.env);
  return new RuntimeGuardPipeline({
    guards: [createRuntimeLoopGuard(config)],
    onDecision: options.onDecision,
  });
}
