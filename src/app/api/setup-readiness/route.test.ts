import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
  getInternalTaskScope: vi.fn(),
  canAccessHive: vi.fn(),
  loadModelRoutingView: vi.fn(),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", async () => {
  const actual = await vi.importActual<typeof import("../_lib/auth")>("../_lib/auth");
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    requireApiUser: mocks.requireApiUser,
    getInternalTaskScope: mocks.getInternalTaskScope,
  };
});

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/model-routing/registry", () => ({
  loadModelRoutingView: mocks.loadModelRoutingView,
}));

import { GET } from "./route";

let tmp: string;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

describe("GET /api/setup-readiness hive scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-readiness-route-"));
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    globalThis.fetch = originalFetch;

    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "owner@example.com", isSystemOwner: false },
    });
    mocks.getInternalTaskScope.mockResolvedValue({ ok: true, scope: null });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.loadModelRoutingView.mockResolvedValue({
      models: [
        { provider: "openai", adapterType: "codex", model: "gpt-5.5", hiveModelEnabled: true, routingEnabled: true },
        { provider: "local", adapterType: "ollama", model: "qwen3:32b", hiveModelEnabled: true, routingEnabled: true },
        { provider: "anthropic", adapterType: "claude-code", model: "claude-opus", hiveModelEnabled: false, routingEnabled: false },
        { provider: "google", adapterType: "gemini", model: "gemini-pro", hiveModelEnabled: false, routingEnabled: false },
      ],
      policy: {
        candidates: [
          activeCandidate("codex", "gpt-5.5"),
          activeCandidate("ollama", "qwen3:32b"),
          excludedCandidate("claude-code", "claude-opus"),
          excludedCandidate("gemini", "gemini-pro"),
        ],
      },
    });

    writeStub("codex", "#!/usr/bin/env bash\nexit 0\n");
    writeStub("claude", "#!/usr/bin/env bash\nexit 0\n");
    writeStub("gemini", "#!/usr/bin/env bash\nexit 0\n");
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "qwen3:32b" }] });
      }
      return new Response("not found", { status: 404 });
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env.PATH = originalPath;
    globalThis.fetch = originalFetch;
  });

  it("omits inactive claude-code and gemini runtime checks for hive-scoped requests", async () => {
    const res = await GET(new Request("http://localhost/api/setup-readiness?hiveId=hive-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.runtimes.codex.status).toBe("ready");
    expect(body.data.runtimes.ollama.status).toBe("ready");
    expect(body.data.runtimes).not.toHaveProperty("claude-code");
    expect(body.data.runtimes).not.toHaveProperty("gemini");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-1");
  });

  it("rejects hive-scoped reads that exceed the internal task hive scope", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "internal-service-account", email: "service@hivewright.local", isSystemOwner: true },
    });
    mocks.getInternalTaskScope.mockResolvedValueOnce({
      ok: true,
      scope: { taskId: "task-1", hiveId: "hive-1", assignedTo: "performance-analyst", parentTaskId: null },
    });

    const res = await GET(new Request("http://localhost/api/setup-readiness?hiveId=other-hive"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: task scope cannot access this hive");
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
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

function activeCandidate(adapterType: string, model: string) {
  return {
    adapterType,
    model,
    enabled: true,
    canonicalRouteSet: {
      membership: "included",
    },
  };
}

function excludedCandidate(adapterType: string, model: string) {
  return {
    adapterType,
    model,
    enabled: false,
    canonicalRouteSet: {
      membership: "excluded",
    },
  };
}
