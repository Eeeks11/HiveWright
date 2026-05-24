import { describe, expect, it } from "vitest";
import {
  buildDiagnosticStatus,
  summarizeDiagnostics,
  redactDiagnosticText,
} from "@/diagnostics/types";

describe("diagnostic status helpers", () => {
  it("builds deterministic diagnostic statuses with owner-safe fields", () => {
    const checkedAt = new Date("2026-05-24T08:15:00.000Z");

    const status = buildDiagnosticStatus({
      id: "runtime.env",
      label: "Runtime configuration",
      severity: "critical",
      summary: "Missing INTERNAL_SERVICE_TOKEN",
      details: "DATABASE_URL=postgres://user:secret@localhost/db",
      recommendedAction: "Set INTERNAL_SERVICE_TOKEN and restart HiveWright.",
      requiresOwnerAction: true,
      checkedAt,
    });

    expect(status).toEqual({
      id: "runtime.env",
      label: "Runtime configuration",
      severity: "critical",
      summary: "Missing INTERNAL_SERVICE_TOKEN",
      details: "DATABASE_URL=[redacted]",
      recommendedAction: "Set INTERNAL_SERVICE_TOKEN and restart HiveWright.",
      requiresOwnerAction: true,
      checkedAt: "2026-05-24T08:15:00.000Z",
    });
  });

  it("redacts common secret-bearing text without hiding useful evidence", () => {
    const redacted = redactDiagnosticText(
      "OpenAI failed with OPENAI_API_KEY=sk-live-secret and Authorization: Bearer token-123 while reaching localhost:11434",
    );

    expect(redacted).not.toContain("sk-live-secret");
    expect(redacted).not.toContain("token-123");
    expect(redacted).toContain("OPENAI_API_KEY=[redacted]");
    expect(redacted).toContain("Authorization: Bearer [redacted]");
    expect(redacted).toContain("localhost:11434");
  });

  it("summarizes the worst severity and readiness blockers", () => {
    const checkedAt = new Date("2026-05-24T08:15:00.000Z");
    const summary = summarizeDiagnostics([
      buildDiagnosticStatus({
        id: "app.alive",
        label: "App process",
        severity: "ok",
        summary: "App process is alive.",
        checkedAt,
      }),
      buildDiagnosticStatus({
        id: "dispatcher.heartbeat",
        label: "Dispatcher heartbeat",
        severity: "warning",
        summary: "Dispatcher heartbeat is stale.",
        checkedAt,
      }),
      buildDiagnosticStatus({
        id: "runtime.env",
        label: "Runtime configuration",
        severity: "critical",
        summary: "Missing required runtime config.",
        checkedAt,
        requiresOwnerAction: true,
      }),
    ]);

    expect(summary).toEqual({
      severity: "critical",
      ready: false,
      counts: { ok: 1, info: 0, warning: 1, critical: 1 },
      ownerActionRequired: true,
    });
  });
});
