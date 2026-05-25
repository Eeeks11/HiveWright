// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbeddingsSettingsPage from "../../src/app/(dashboard)/settings/embeddings/page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("EmbeddingsSettingsPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps the selected target visible and disables save while re-embedding is active", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/embedding-config/local-setup")) {
        return jsonResponse({ data: localSetupResponse({ reachable: false, modelInstalled: false, embeddingTestOk: false }) });
      }
      if (url.includes("/api/embedding-config") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: {
            config: {
              id: "cfg-1",
              provider: "openrouter",
              modelName: "openai/text-embedding-3-small",
              dimension: 1536,
              apiCredentialKey: "OPENROUTER_API_KEY",
              endpointOverride: "https://openrouter.ai/api/v1",
              status: "reembedding",
              lastReembeddedId: null,
              reembedTotal: 120,
              reembedProcessed: 35,
              reembedStartedAt: "2026-04-22T08:01:00.000Z",
              reembedFinishedAt: null,
              lastError: null,
              updatedAt: "2026-04-22T08:01:00.000Z",
              updatedBy: "owner@local",
            },
            catalog: embeddingCatalog(),
            errorSummary: {
              count: 2,
              latestMessage: "Row 36 timed out",
            },
            recentErrors: [],
          },
        });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({
          data: [
            { id: "cred-1", key: "OPENROUTER_API_KEY", name: "OpenRouter" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<EmbeddingsSettingsPage />);

    const providerSelect = await screen.findByRole("combobox", { name: /Provider/i });
    const modelSelect = screen.getByRole("combobox", { name: /Model/i });
    expect((providerSelect as HTMLSelectElement).value).toBe("openrouter");
    expect((modelSelect as HTMLSelectElement).value).toBe("openai/text-embedding-3-small");
    expect(screen.getByDisplayValue("1536")).toBeTruthy();
    expect(screen.getByDisplayValue("https://openrouter.ai/api/v1")).toBeTruthy();
    expect(screen.getByText(/Re-embedding is currently running/i)).toBeTruthy();
    expect(screen.getByText(/Progress: 35 of 120/i)).toBeTruthy();
    expect(screen.getByText(/2 re-embed errors logged/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Re-embed running/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets the owner stop a stuck re-embed and save corrected settings", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });

      if (url.includes("/api/embedding-config/local-setup")) {
        return jsonResponse({ data: localSetupResponse({ reachable: false, modelInstalled: false, embeddingTestOk: false }) });
      }
      if (url.includes("/api/embedding-config") && init?.method === "DELETE") {
        return jsonResponse({
          data: {
            stopped: true,
            config: {
              id: "cfg-1",
              provider: "openrouter",
              modelName: "openai/text-embedding-3-small",
              dimension: 1536,
              apiCredentialKey: "OPENROUTER_API_KEY",
              endpointOverride: "https://openrouter.ai/api/v1",
              status: "error",
              lastReembeddedId: null,
              reembedTotal: 120,
              reembedProcessed: 35,
              reembedStartedAt: "2026-04-22T08:01:00.000Z",
              reembedFinishedAt: "2026-04-22T08:05:00.000Z",
              lastError: "Re-embed stopped by owner so settings can be corrected.",
              updatedAt: "2026-04-22T08:05:00.000Z",
              updatedBy: "owner@local",
            },
            errorSummary: null,
            recentErrors: [],
          },
        });
      }
      if (url.includes("/api/embedding-config") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: {
            config: {
              id: "cfg-1",
              provider: "openrouter",
              modelName: "openai/text-embedding-3-small",
              dimension: 1536,
              apiCredentialKey: "OPENROUTER_API_KEY",
              endpointOverride: "https://openrouter.ai/api/v1",
              status: "reembedding",
              lastReembeddedId: null,
              reembedTotal: 120,
              reembedProcessed: 35,
              reembedStartedAt: "2026-04-22T08:01:00.000Z",
              reembedFinishedAt: null,
              lastError: null,
              updatedAt: "2026-04-22T08:01:00.000Z",
              updatedBy: "owner@local",
            },
            catalog: embeddingCatalog(),
            errorSummary: null,
            recentErrors: [],
          },
        });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({
          data: [
            { id: "cred-1", key: "OPENROUTER_API_KEY", name: "OpenRouter" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<EmbeddingsSettingsPage />);

    const stopButton = await screen.findByRole("button", { name: /Stop re-embed and edit settings/i });
    fireEvent.click(stopButton);

    await waitFor(() => expect(calls.some((call) => call.init?.method === "DELETE")).toBe(true));
    expect(await screen.findByText(/Re-embed stopped\. You can now correct the endpoint and save again\./i)).toBeTruthy();
    expect(screen.getByText(/Status: error/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save & re-embed/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders terminal error state details after a run finishes with failures", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/embedding-config/local-setup")) {
        return jsonResponse({ data: localSetupResponse({ reachable: true, modelInstalled: true, embeddingTestOk: true }) });
      }
      if (url.includes("/api/embedding-config") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: {
            config: {
              id: "cfg-2",
              provider: "openrouter",
              modelName: "openai/text-embedding-3-small",
              dimension: 1536,
              apiCredentialKey: "OPENROUTER_API_KEY",
              endpointOverride: "https://openrouter.ai/api/v1",
              status: "error",
              lastReembeddedId: "mem-50",
              reembedTotal: 80,
              reembedProcessed: 80,
              reembedStartedAt: "2026-04-22T08:00:00.000Z",
              reembedFinishedAt: "2026-04-22T08:03:00.000Z",
              lastError: "1 chunk failed",
              updatedAt: "2026-04-22T08:03:00.000Z",
              updatedBy: "owner@local",
            },
            catalog: embeddingCatalog(),
            errorSummary: {
              count: 1,
              latestMessage: "Chunk 51 provider timeout",
            },
            recentErrors: [
              {
                id: "err-1",
                memoryEmbeddingId: "mem-51",
                sourceType: "note",
                sourceId: "note-51",
                chunkText: "problem row",
                errorMessage: "Chunk 51 provider timeout",
                attemptCount: 1,
                updatedAt: "2026-04-22T08:03:00.000Z",
              },
            ],
          },
        });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({
          data: [
            { id: "cred-1", key: "OPENROUTER_API_KEY", name: "OpenRouter" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<EmbeddingsSettingsPage />);

    await waitFor(() => expect(screen.getByText(/Status: error/i)).toBeTruthy());
    expect(screen.getByText(/Latest run: 80 of 80 processed. 1 failed./i)).toBeTruthy();
    expect(screen.getByText(/1 re-embed error logged. Latest: Chunk 51 provider timeout/i)).toBeTruthy();
    expect(screen.getByText(/Recent row failures/i)).toBeTruthy();
    expect(screen.getByText(/note \/ note-51/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save & re-embed/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("renders local setup doctor and performs safe owner-confirmed actions", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });

      if (url.includes("/api/embedding-config/local-setup/install-ollama")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ confirmed: true }));
        return jsonResponse({ data: { result: { installed: true, status: localSetupResponse({ reachable: true, modelInstalled: false, embeddingTestOk: false }).status } } });
      }
      if (url.includes("/api/embedding-config/local-setup/pull-model")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ modelName: "nomic-embed-text-v2-moe:latest" }));
        return jsonResponse({ data: { result: { ok: true }, status: localSetupResponse({ reachable: true, modelInstalled: true, embeddingTestOk: true }).status } });
      }
      if (url.includes("/api/embedding-config/local-setup/use")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          data: {
            config: {
              id: "local-cfg",
              provider: "ollama",
              modelName: "nomic-embed-text-v2-moe:latest",
              dimension: 768,
              apiCredentialKey: null,
              endpointOverride: "http://localhost:11434",
              status: "reembedding",
              lastReembeddedId: null,
              reembedTotal: 4,
              reembedProcessed: 0,
              reembedStartedAt: "2026-05-16T00:00:00.000Z",
              reembedFinishedAt: null,
              lastError: null,
              updatedAt: "2026-05-16T00:00:00.000Z",
              updatedBy: "owner@local",
            },
            errorSummary: null,
            recentErrors: [],
          },
        });
      }
      if (url.includes("/api/embedding-config/local-setup")) {
        return jsonResponse({ data: localSetupResponse({ reachable: false, modelInstalled: false, embeddingTestOk: false }) });
      }
      if (url.includes("/api/embedding-config") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          data: {
            config: null,
            catalog: embeddingCatalog(),
            errorSummary: null,
            recentErrors: [],
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<EmbeddingsSettingsPage />);

    await screen.findByText(/Local-first memory setup/i);
    expect(screen.getByText(/Ollama is not reachable/i)).toBeTruthy();
    expect(screen.getByText(/Detected HiveWright server OS: Linux/i)).toBeTruthy();
    expect(screen.getByText(/Copy\/paste these Linux steps/i)).toBeTruthy();
    expect(screen.getAllByText(/nomic-embed-text-v2-moe:latest/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/curl -fsSL https:\/\/ollama.com\/install.sh \| sh/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Install Ollama/i }));
    expect(await screen.findByText(/Confirm Ollama installation/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Yes, install Ollama/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes("install-ollama"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: /Pull default model/i }));
    await waitFor(() => expect(calls.some((call) => call.url.includes("pull-model"))).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: /Use local embeddings/i }));
    await waitFor(() => expect(calls.some((call) => call.url.includes("/use"))).toBe(true));
    expect(screen.queryByText(/rm -rf|powershell -enc/i)).toBeNull();
  });
});

function localSetupResponse({ reachable, modelInstalled, embeddingTestOk }: { reachable: boolean; modelInstalled: boolean; embeddingTestOk: boolean }) {
  return {
    status: {
      platform: "linux",
      endpoint: "http://localhost:11434",
      reachable,
      modelInstalled,
      embeddingTestOk,
      defaultModel: "nomic-embed-text-v2-moe:latest",
      dimension: 768,
      error: reachable ? null : "Ollama is not reachable",
    },
    plan: {
      platform: "linux",
      recommended: {
        title: "Recommended: let HiveWright install Ollama",
        description: "HiveWright can run the allowlisted Ollama installer after you confirm.",
        warnings: ["Installer actions require owner confirmation."],
        actions: ["curl -fsSL https://ollama.com/install.sh | sh"],
      },
      manual: {
        title: "Manual Linux setup",
        steps: [
          "Install Ollama from https://ollama.com/download",
          "curl -fsSL https://ollama.com/install.sh | sh",
          "ollama pull nomic-embed-text-v2-moe:latest",
        ],
      },
    },
    defaultConfig: {
      provider: "ollama",
      modelName: "nomic-embed-text-v2-moe:latest",
      dimension: 768,
      endpointOverride: "http://localhost:11434",
      apiCredentialKey: null,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function embeddingCatalog() {
  return [
    {
      provider: "ollama",
      label: "Ollama",
      models: [{ modelName: "nomic-embed-text", dimension: 768 }],
    },
    {
      provider: "openrouter",
      label: "OpenRouter",
      models: [{ modelName: "openai/text-embedding-3-small", dimension: 1536 }],
    },
  ];
}
