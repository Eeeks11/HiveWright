export type AdapterRuntimeEvent =
  | {
      type: "tool_call";
      adapter: "codex" | "claude-code" | string;
      toolName: string;
      args: unknown;
      callId?: string | null;
      source: "structured_stream";
      timestamp: Date;
    }
  | {
      type: "status";
      adapter: string;
      message: string;
      timestamp: Date;
    };

export interface AdapterRuntimeHooks {
  onRuntimeEvent?: (event: AdapterRuntimeEvent) => Promise<void> | void;
  shouldInterrupt?: () => boolean;
  interruptReason?: () => string | null;
}

export type RuntimeGuardMode = "off" | "diagnostic" | "enforce";

export interface RuntimeLoopGuardConfig {
  mode: RuntimeGuardMode;
  warnThreshold: number;
  hardLimit: number;
  windowSize: number;
  toolFrequencyWarn: number;
  toolFrequencyHardLimit: number;
}

export type RuntimeGuardAction = "none" | "warn" | "interrupt";

export interface RuntimeGuardDecision {
  action: RuntimeGuardAction;
  guard: string;
  reason: string | null;
  event?: AdapterRuntimeEvent;
  metadata?: Record<string, unknown>;
}

export interface RuntimeGuard {
  name: string;
  observe(event: AdapterRuntimeEvent): RuntimeGuardDecision;
  reset?(): void;
}
