import type {
  AdapterRuntimeEvent,
  AdapterRuntimeHooks,
  RuntimeGuard,
  RuntimeGuardDecision,
} from "./types";

export interface RuntimeGuardPipelineOptions {
  guards: RuntimeGuard[];
  onDecision?: (decision: RuntimeGuardDecision) => Promise<void> | void;
}

export class RuntimeGuardPipeline {
  private readonly guards: RuntimeGuard[];
  private readonly onDecision?: (decision: RuntimeGuardDecision) => Promise<void> | void;
  private interrupted = false;
  private reason: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RuntimeGuardPipelineOptions) {
    this.guards = options.guards;
    this.onDecision = options.onDecision;
  }

  async handleEvent(event: AdapterRuntimeEvent): Promise<void> {
    this.chain = this.chain.then(() => this.handleEventSerial(event));
    return this.chain;
  }

  private async handleEventSerial(event: AdapterRuntimeEvent): Promise<void> {
    if (this.interrupted) return;

    for (const guard of this.guards) {
      const decision = guard.observe(event);
      if (decision.action === "none") continue;
      if (decision.action === "interrupt") {
        this.interrupted = true;
        this.reason = decision.reason ?? "Runtime guard interrupted execution.";
      }
      await this.onDecision?.(decision);
      if (decision.action === "interrupt") {
        return;
      }
    }
  }

  shouldInterrupt(): boolean {
    return this.interrupted;
  }

  interruptReason(): string | null {
    return this.reason;
  }

  hooks(): AdapterRuntimeHooks {
    return {
      onRuntimeEvent: (event) => this.handleEvent(event),
      shouldInterrupt: () => this.shouldInterrupt(),
      interruptReason: () => this.interruptReason(),
    };
  }
}
