import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiAuth: vi.fn(),
  collectSetupRuntimeReadiness: vi.fn(),
  listActiveSetupRuntimeSources: vi.fn(),
  listSetupRuntimeReadinessWarnings: vi.fn(),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
}));

vi.mock("@/setup-readiness/runtime", () => ({
  collectSetupRuntimeReadiness: mocks.collectSetupRuntimeReadiness,
  listActiveSetupRuntimeSources: mocks.listActiveSetupRuntimeSources,
  listSetupRuntimeReadinessWarnings: mocks.listSetupRuntimeReadinessWarnings,
}));

import { GET } from "./route";

const HIVE_ID = "b6b815ba-5109-4066-8a33-cc5560d3a0e1";

const snapshot = {
  checkedAt: "2026-06-23T00:00:00.000Z",
  runtimes: {
    ollama: {
      label: "Ollama",
      installed: true,
      status: "ready",
      detail: "Ollama is reachable.",
      nextStep: "Ready.",
    },
    "claude-code": {
      label: "Claude Code",
      installed: false,
      status: "missing",
      detail: "Claude Code command is not installed on this server.",
      nextStep: "Install Claude Code.",
    },
    gemini: {
      label: "Gemini CLI",
      installed: true,
      status: "check_required",
      detail: "Gemini CLI is installed, but auth was not checked.",
      nextStep: "Sign in to Gemini CLI.",
    },
  },
};

describe("GET /api/setup-readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.collectSetupRuntimeReadiness.mockResolvedValue(snapshot);
    mocks.listActiveSetupRuntimeSources.mockResolvedValue(["ollama"]);
    mocks.listSetupRuntimeReadinessWarnings.mockReturnValue([
      {
        source: "claude-code",
        label: "Claude Code",
        status: "missing",
        policy: "optional_runtime",
        detail: "Claude Code command is not installed on this server.",
        nextStep: "Install Claude Code.",
      },
      {
        source: "gemini",
        label: "Gemini CLI",
        status: "check_required",
        policy: "optional_runtime",
        detail: "Gemini CLI is installed, but auth was not checked.",
        nextStep: "Sign in to Gemini CLI.",
      },
    ]);
  });

  it("preserves the legacy runtime snapshot response when no hive is requested", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual(snapshot);
    expect(mocks.listActiveSetupRuntimeSources).not.toHaveBeenCalled();
    expect(mocks.listSetupRuntimeReadinessWarnings).not.toHaveBeenCalled();
  });

  it("scopes warning policy to hive-active setup runtime sources", async () => {
    const res = await GET(new Request(`http://localhost/api/setup-readiness?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.listActiveSetupRuntimeSources).toHaveBeenCalledWith(mocks.sql, { hiveId: HIVE_ID });
    expect(mocks.listSetupRuntimeReadinessWarnings).toHaveBeenCalledWith(snapshot, { activeSources: ["ollama"] });
    expect(body.data.warningSources).toEqual([
      expect.objectContaining({ source: "claude-code", policy: "optional_runtime" }),
      expect.objectContaining({ source: "gemini", policy: "optional_runtime" }),
    ]);
    expect(body.data.warningSources.some((warning: { policy: string }) => warning.policy === "active_provider")).toBe(false);
  });

  it("rejects malformed hive-scoped setup readiness requests", async () => {
    const res = await GET(new Request("http://localhost/api/setup-readiness?hiveId=not-a-uuid"));

    expect(res.status).toBe(400);
    expect(mocks.collectSetupRuntimeReadiness).not.toHaveBeenCalled();
    expect(mocks.listActiveSetupRuntimeSources).not.toHaveBeenCalled();
  });
});
