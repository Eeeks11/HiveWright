export const RETIRED_OPENCLAW_MESSAGE = "OpenClaw is retired and unsupported for dispatch/probe execution. Use codex or claude-code instead.";

export const SUPPORTED_RUNTIME_ADAPTERS = [
  "ollama",
  "claude-code",
  "codex",
  "gemini",
  "openai-image",
] as const;

export type SupportedRuntimeAdapter = typeof SUPPORTED_RUNTIME_ADAPTERS[number];

export class UnsupportedAdapterError extends Error {
  constructor(adapterType: string) {
    const normalized = normalizeAdapterType(adapterType);
    super(
      normalized === "openclaw"
        ? RETIRED_OPENCLAW_MESSAGE
        : `Unsupported adapter type "${adapterType}". Supported adapters: ${SUPPORTED_RUNTIME_ADAPTERS.join(", ")}. OpenClaw is retired; use codex or claude-code instead.`,
    );
    this.name = "UnsupportedAdapterError";
  }
}

export function normalizeAdapterType(adapterType: string | null | undefined): string {
  return (adapterType ?? "").trim().toLowerCase();
}

export function assertSupportedRuntimeAdapter(adapterType: string): SupportedRuntimeAdapter {
  const normalized = normalizeAdapterType(adapterType);
  if (normalized === "openclaw") {
    throw new UnsupportedAdapterError(normalized);
  }
  if ((SUPPORTED_RUNTIME_ADAPTERS as readonly string[]).includes(normalized)) {
    return normalized as SupportedRuntimeAdapter;
  }
  throw new UnsupportedAdapterError(adapterType);
}
