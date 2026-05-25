import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDoctorReport,
  buildSetupGuide,
  writeEnvTemplateIfRequested,
  type DoctorRuntime,
} from "@/setup-doctor/reliability";

function runtime(overrides: Partial<DoctorRuntime> = {}): DoctorRuntime {
  return {
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://user:super-secret@localhost:5432/hivewrightv2",
      ENCRYPTION_KEY: "encryption-secret-value",
      INTERNAL_SERVICE_TOKEN: "internal-token-value",
      STRIPE_SECRET_KEY: "stripe-secret-value",
    },
    commandAvailable: (name) => ["node", "npm", "tsx"].includes(name),
    npmScriptNames: () => [
      "check:migrations",
      "security:scan",
      "dispatcher",
      "readiness:dispatcher-health",
      "readiness:ai-budget-profile",
      "readiness:emergency-stop",
    ],
    dbReachable: async () => ({ ok: true }),
    migrationJournalOk: async () => ({ ok: true }),
    now: () => new Date("2026-05-19T12:00:00.000Z"),
    ...overrides,
  };
}

describe("setup/doctor reliability commands", () => {
  it("builds a read-only doctor report that shows required env names without leaking values", async () => {
    const report = await buildDoctorReport(runtime());
    const text = report.markdown;

    expect(report.mutations).toEqual([]);
    expect(text).toContain("DATABASE_URL: set");
    expect(text).toContain("ENCRYPTION_KEY: set");
    expect(text).toContain("INTERNAL_SERVICE_TOKEN: set");
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("encryption-secret-value");
    expect(text).not.toContain("internal-token-value");
    expect(text).not.toContain("stripe-secret-value");
    expect(text).toContain("DB reachability: pass");
    expect(text).toContain("Migration journal: pass");
    expect(text).toContain("Security scan command: available");
    expect(text).toContain("Dispatcher command: available");
    expect(text).toContain("Budget visibility: available");
    expect(text).toContain("Emergency stop visibility: available");
  });

  it("reports missing prerequisites without throwing or printing secret values", async () => {
    const report = await buildDoctorReport(runtime({
      env: { NODE_ENV: "test", DATABASE_URL: "postgres://user:hidden@localhost/db" },
      commandAvailable: (name) => name === "node",
      npmScriptNames: () => ["check:migrations"],
      dbReachable: async () => ({ ok: false, detail: "connection refused" }),
      migrationJournalOk: async () => ({ ok: false, detail: "journal mismatch" }),
    }));

    expect(report.status).toBe("fail");
    expect(report.markdown).toContain("ENCRYPTION_KEY: missing");
    expect(report.markdown).toContain("INTERNAL_SERVICE_TOKEN: missing");
    expect(report.markdown).toContain("DB reachability: fail");
    expect(report.markdown).toContain("Migration journal: fail");
    expect(report.markdown).not.toContain("hidden");
  });

  it("builds guided setup text without writing env files by default", () => {
    const guide = buildSetupGuide({ writeEnvTemplate: false });

    expect(guide.mutations).toEqual([]);
    expect(guide.markdown).toContain("npm run doctor");
    expect(guide.markdown).toContain("npm run db:migrate:app");
    expect(guide.markdown).toContain("npm run dispatcher");
    expect(guide.markdown).not.toContain("super-secret");
  });

  it("writes only a placeholder env template when explicitly requested and never overwrites existing files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hivewright-setup-test-"));
    try {
      const target = path.join(dir, ".env.local.example");
      const result = writeEnvTemplateIfRequested({ writeEnvTemplate: true, targetPath: target });
      expect(result.written).toBe(true);
      const content = readFileSync(target, "utf8");
      expect(content).toContain("DATABASE_URL=");
      expect(content).toContain("ENCRYPTION_KEY=");
      expect(content).toContain("INTERNAL_SERVICE_TOKEN=");
      expect(content).not.toContain("secret-value");
      expect(() => writeEnvTemplateIfRequested({ writeEnvTemplate: true, targetPath: target })).toThrow(/already exists/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
