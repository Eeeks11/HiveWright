import { beforeEach, describe, expect, it, vi } from "vitest";

const bundleMock = vi.hoisted(() => ({
  buildDiagnosticBundle: vi.fn(),
}));

vi.mock("@/diagnostics/bundle", () => bundleMock);

describe("GET /api/diagnostics/bundle", () => {
  beforeEach(() => {
    bundleMock.buildDiagnosticBundle.mockReset();
  });

  it("exports a sanitized support bundle", async () => {
    bundleMock.buildDiagnosticBundle.mockResolvedValue({
      generatedAt: "2026-05-24T08:15:00.000Z",
      health: { status: "ok" },
      readiness: { ready: true },
      diagnostics: [],
      recentFailureGroups: [],
    });
    const { GET } = await import("../../src/app/api/diagnostics/bundle/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.generatedAt).toBe("2026-05-24T08:15:00.000Z");
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|token|secret/i);
  });
});
