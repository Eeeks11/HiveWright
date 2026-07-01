import type { ChatProvider, ProviderId } from "./types";
import { OllamaChatProvider } from "./ollama";
import { OpenRouterChatProvider } from "./openrouter";
import { getCanonicalOllamaEndpoint } from "@/ollama/endpoint";

export * from "./types";
export { OllamaChatProvider } from "./ollama";
export { OpenRouterChatProvider } from "./openrouter";
export {
  generateStructuredJson,
  parseStructuredJson,
  validateStructuredJson,
  type StructuredJsonSchema,
} from "./structured";

export interface GetProviderOpts {
  ollamaEndpoint?: string;
  openrouterApiKey?: string;
  fetchFn?: typeof fetch;
}

export function getChatProvider(id: ProviderId, opts: GetProviderOpts = {}): ChatProvider | null {
  if (id === "none") return null;
  if (id === "ollama") {
    const endpoint = getCanonicalOllamaEndpoint({ endpoint: opts.ollamaEndpoint });
    return new OllamaChatProvider(endpoint, opts.fetchFn);
  }
  if (id === "openrouter") {
    const key = opts.openrouterApiKey ?? "";
    return new OpenRouterChatProvider(key, opts.fetchFn);
  }
  return null;
}
