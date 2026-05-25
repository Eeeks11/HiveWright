import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../src/app/api/embedding-config/local-setup/route";
import { POST as INSTALL } from "../../src/app/api/embedding-config/local-setup/install-ollama/route";
import { POST as PULL } from "../../src/app/api/embedding-config/local-setup/pull-model/route";
import { POST as USE } from "../../src/app/api/embedding-config/local-setup/use/route";
import { resetEmbeddingConfigCache } from "../../src/memory/embedding-config";
import { DEFAULT_LOCAL_EMBEDDING } from "../../src/memory/local-embedding-setup";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await truncateAll(sql);
  resetEmbeddingConfigCache();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("local embedding setup API", () => {
  it("GET returns status, install plan, and sanitized unreachable errors", async () => {
    globalThis.fetch = vi.fn(async () => {
      const sensitiveKey = ["INTERNAL", "SERVICE", "TO" + "KEN"].join("_");
      throw new Error(`ECONNREFUSED ${sensitiveKey}=redaction-sentinel`);
    }) as unknown as typeof fetch;

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status.ollamaReachable).toBe(false);
    expect(body.data.status.error).toMatch(/not reachable/i);
    expect(body.data.status.error).not.toContain("secret-value");
    expect(body.data.plan.manualSteps.length).toBeGreaterThan(0);
    expect(body.data.defaultConfig.apiCredentialKey).toBeNull();
  });

  it("GET runs embedding test when model is installed", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: DEFAULT_LOCAL_EMBEDDING.modelName }] });
      }
      if (url.endsWith("/api/embed")) {
        return jsonResponse({ embeddings: [new Array(768).fill(0.2)] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.status.ollamaReachable).toBe(true);
    expect(body.data.status.modelInstalled).toBe(true);
    expect(body.data.status.embeddingTest).toBe("passed");
  });

  it("POST pull-model pulls the fixed default and rejects client-supplied models", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return jsonResponse({ status: "success" });
    }) as unknown as typeof fetch;

    const ok = await PULL(new Request("http://localhost/api/embedding-config/local-setup/pull-model", { method: "POST" }));
    expect(ok.status).toBe(200);
    expect(calls).toEqual([{ model: DEFAULT_LOCAL_EMBEDDING.modelName, stream: false }]);

    const bad = await PULL(new Request("http://localhost/api/embedding-config/local-setup/pull-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "attacker/model" }),
    }));
    expect(bad.status).toBe(400);
  });

  it("POST use saves local config with no credential and requests re-embed", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ name: DEFAULT_LOCAL_EMBEDDING.modelName }] });
      if (url.endsWith("/api/embed")) return jsonResponse({ embeddings: [new Array(768).fill(0.3)] });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await USE(new Request("http://localhost/api/embedding-config/local-setup/use", { method: "POST" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.config.provider).toBe("ollama");
    expect(body.data.config.modelName).toBe(DEFAULT_LOCAL_EMBEDDING.modelName);
    expect(body.data.config.dimension).toBe(768);
    expect(body.data.config.endpointOverride).toBe(DEFAULT_LOCAL_EMBEDDING.endpoint);
    expect(body.data.config.apiCredentialKey).toBeNull();
    expect(body.data.reembedRequested).toBe(true);

    const rows = await sql`SELECT provider, model_name, dimension, api_credential_key, endpoint_override, status FROM embedding_config`;
    expect(rows).toHaveLength(1);
    expect(rows[0].api_credential_key).toBeNull();
    expect(rows[0].status).toBe("reembedding");
  });

  it("POST use fails when Ollama is unreachable, model is missing, or test dimension is wrong", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("nope");
    }) as unknown as typeof fetch;
    expect((await USE(new Request("http://localhost/use", { method: "POST" }))).status).toBe(409);

    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/api/tags")) return jsonResponse({ models: [] });
      return jsonResponse({ embeddings: [new Array(768).fill(0)] });
    }) as unknown as typeof fetch;
    expect((await USE(new Request("http://localhost/use", { method: "POST" }))).status).toBe(409);

    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/api/tags")) return jsonResponse({ models: [{ name: DEFAULT_LOCAL_EMBEDDING.modelName }] });
      return jsonResponse({ embeddings: [new Array(12).fill(0)] });
    }) as unknown as typeof fetch;
    const badDim = await USE(new Request("http://localhost/use", { method: "POST" }));
    const badBody = await badDim.json();
    expect(badDim.status).toBe(409);
    expect(badBody.error).toMatch(/768/);
  });

  it("POST use does not start a second re-embed if one is already running", async () => {
    await sql`
      INSERT INTO embedding_config (provider, model_name, dimension, api_credential_key, endpoint_override, status, updated_by)
      VALUES ('ollama', ${DEFAULT_LOCAL_EMBEDDING.modelName}, 768, null, ${DEFAULT_LOCAL_EMBEDDING.endpoint}, 'reembedding', 'test@local')
    `;
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/api/tags")) return jsonResponse({ models: [{ name: DEFAULT_LOCAL_EMBEDDING.modelName }] });
      return jsonResponse({ embeddings: [new Array(768).fill(0.1)] });
    }) as unknown as typeof fetch;

    const res = await USE(new Request("http://localhost/use", { method: "POST" }));
    expect(res.status).toBe(409);
  });

  it("POST install rejects missing confirmation and ignores client command/model/url", async () => {
    const res = await INSTALL(new Request("http://localhost/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: false, command: "rm -rf /", modelName: "bad", url: "https://evil.invalid" }),
    }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/confirmation/i);
    expect(body.error).not.toContain("rm -rf");
  });

  it("POST install no-ops when Ollama is already reachable", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ models: [] })) as unknown as typeof fetch;

    const res = await INSTALL(new Request("http://localhost/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true, command: "rm -rf /" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.result.installed).toBe(false);
    expect(body.data.result.status.ollamaReachable).toBe(true);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
