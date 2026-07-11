const DEFAULT_OLLAMA_ENDPOINT = "http://192.168.50.68:11434";

export function getCanonicalOllamaEndpoint(input?: {
  endpoint?: string | null;
  baseUrl?: string | null;
}): string {
  return trimTrailingSlash(
    firstPresent(
      input?.endpoint,
      input?.baseUrl,
      process.env.OLLAMA_ENDPOINT,
      process.env.OLLAMA_BASE_URL,
      DEFAULT_OLLAMA_ENDPOINT,
    )!,
  );
}

export function getCanonicalOllamaHealthBaseUrl(input?: {
  provider?: string | null;
  adapterType?: string | null;
  baseUrl?: string | null;
}): string | null {
  if (!isOllamaRoute(input?.provider, input?.adapterType)) return input?.baseUrl ?? null;
  return getCanonicalOllamaEndpoint({ baseUrl: input?.baseUrl });
}

export function isOllamaRoute(provider?: string | null, adapterType?: string | null): boolean {
  return provider?.trim().toLowerCase() === "local" || adapterType?.trim().toLowerCase() === "ollama";
}

function firstPresent(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
