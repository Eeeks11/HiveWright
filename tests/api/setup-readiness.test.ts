import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET } from "../../src/app/api/setup-readiness/route";

let tmp: string;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-"));
  process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env.PATH = originalPath;
  globalThis.fetch = originalFetch;
});

describe("GET /api/setup-readiness", () => {
  it("reports installed CLI runtimes and local Ollama readiness without leaking command output", async () => {
    writeStub("codex", "#!/usr/bin/env bash\necho codex 0.128.0\n");
    writeStub("claude", "#!/usr/bin/env bash\necho Claude Code 1.2.3\n");
    globalThis.fetch = async (input) => {
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
