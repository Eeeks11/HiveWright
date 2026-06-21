import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET } from "../../src/app/api/setup-readiness/route";

let tmp: string;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;
const originalOllamaEndpoint = process.env.OLLAMA_ENDPOINT;
const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-"));
  process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  delete process.env.OLLAMA_ENDPOINT;
  delete process.env.OLLAMA_BASE_URL;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.PATH = originalPath;
  restoreEnv("OLLAMA_ENDPOINT", originalOllamaEndpoint);
  restoreEnv("OLLAMA_BASE_URL", originalOllamaBaseUrl);
  globalThis.fetch = originalFetch;
});

describe("GET /api/setup-readiness", () => {
  it("reports installed CLI runtimes and local Ollama readiness without leaking command output", async () => {
    writeStub("codex", "#!/usr/bin/env bash\necho codex 0.128.0\n");
    writeStub("claude", "#!/usr/bin/env bash\necho Claude Code 1.2.3\n");
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "qwen3:32b" }] });
      }
      return new Response("not found", { status: 404 });
    };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.runtimes.codex.installed).toBe(true);
    expect(body.data.runtimes.codex.status).toBe("ready");
    expect(body.data.runtimes["claude-code"].installed).toBe(true);
    expect(body.data.runtimes.gemini.installed).toBe(false);
    expect(body.data.runtimes.ollama.installed).toBe(true);
    expect(body.data.runtimes.ollama.status).toBe("ready");
    expect(body.data.runtimes.codex.detail).not.toContain("0.128.0");
    expect(calls[0]).toBe("http://192.168.50.68:11434/api/tags");
  });

  it("uses the configured canonical Ollama endpoint instead of hard-coded localhost", async () => {
    process.env.OLLAMA_ENDPOINT = "http://runtime-ollama.test:11434/";
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({ models: [] });
    };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.runtimes.ollama.status).toBe("ready");
    expect(calls[0]).toBe("http://runtime-ollama.test:11434/api/tags");
  });

  it("marks Ollama not ready when the service is unreachable", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED INTERNAL_SERVICE_TOKEN=secret");
    };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.runtimes.ollama.installed).toBe(false);
    expect(body.data.runtimes.ollama.status).toBe("missing");
    expect(body.data.runtimes.ollama.detail).toMatch(/Ollama is not reachable/i);
    expect(body.data.runtimes.ollama.detail).not.toContain("secret");
  });
});

describe("setup runtime readiness warning policy", () => {
  it("labels active-provider warnings separately from undeclared optional runtime debt", async () => {
    const { listSetupRuntimeReadinessWarnings, listActiveProviderReadinessWarnings } = await import("../../src/setup-readiness/runtime");
    const snapshot = {
      checkedAt: "2026-06-21T00:00:00.000Z",
      runtimes: {
        ollama: runtime("Ollama", "missing"),
        gemini: runtime("Gemini CLI", "missing"),
        codex: runtime("Codex", "ready"),
      },
    };

    const warnings = listSetupRuntimeReadinessWarnings(snapshot, { activeSources: ["ollama"] });

    expect(warnings).toEqual([
      expect.objectContaining({ source: "ollama", policy: "active_provider" }),
      expect.objectContaining({ source: "gemini", policy: "optional_runtime" }),
    ]);
    expect(listActiveProviderReadinessWarnings(snapshot, ["ollama"]).map((warning) => warning.source)).toEqual(["ollama"]);
  });

  it("derives active setup runtime sources from enabled model inventory", async () => {
    const { listActiveSetupRuntimeSources } = await import("../../src/setup-readiness/runtime");
    const sql = (async () => [
      { provider: "ollama", adapter_type: "local" },
      { provider: "openai", adapter_type: "codex" },
      { provider: "anthropic", adapter_type: "http" },
      { provider: "ollama", adapter_type: "local" },
    ]) as never;

    await expect(listActiveSetupRuntimeSources(sql)).resolves.toEqual(["codex", "ollama"]);
  });
});

function writeStub(name: string, content: string) {
  const stub = path.join(tmp, name);
  fs.writeFileSync(stub, content);
  fs.chmodSync(stub, 0o755);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function runtime(label: string, status: "ready" | "missing") {
  return {
    label,
    installed: status === "ready",
    status,
    detail: `${label} ${status}`,
    nextStep: status === "ready" ? "Ready." : `Install ${label}.`,
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
