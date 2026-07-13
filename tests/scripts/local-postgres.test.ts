import { describe, expect, it } from "vitest";
import {
  LOCAL_POSTGRES_DEFAULT_PORT,
  resolveLocalPostgresConfig,
  resolveLocalPostgresConfigWithOptions,
  resolveRuntimeRoot,
  shouldUseManagedLocalPostgres,
} from "../../scripts/lib/local-postgres";

describe("local embedded Postgres runtime config", () => {
  it("uses ~/.hivewright by default and keeps data outside the repo", () => {
    const config = resolveLocalPostgresConfigWithOptions(
      { HOME: "/home/tester" },
      {
        userHomeDir: "/home/tester",
        osHomeDir: "/home/tester",
        runtimeRootExists: () => false,
      },
    );

    expect(config.runtimeRoot).toBe("/home/tester/.hivewright");
    expect(config.stateDir).toBe("/home/tester/.hivewright/postgres");
    expect(config.dataDir).toBe("/home/tester/.hivewright/postgres/data");
    expect(config.lockDir).toBe("/home/tester/.hivewright/postgres/startup.lock");
    expect(config.logFile).toBe("/home/tester/.hivewright/postgres/postgres.log");
    expect(config.port).toBe(LOCAL_POSTGRES_DEFAULT_PORT);
    expect(config.url).toContain("127.0.0.1:55432/hivewrightv2");
    expect(config.url).toContain("hivewright-local-dev");
    expect(config.safeUrl).toContain(":***@");
    expect(config.safeUrl).not.toContain("hivewright-local-dev");
  });

  it("allows explicit runtime root and port overrides", () => {
    const config = resolveLocalPostgresConfig({
      HOME: "/home/tester",
      HIVEWRIGHT_RUNTIME_ROOT: "/tmp/hw-runtime",
      HIVEWRIGHT_EMBEDDED_POSTGRES_PORT: "55440",
    });

    expect(resolveRuntimeRoot({ HOME: "/home/tester", HIVEWRIGHT_RUNTIME_ROOT: "/tmp/hw-runtime" })).toBe(
      "/tmp/hw-runtime",
    );
    expect(config.dataDir).toBe("/tmp/hw-runtime/postgres/data");
    expect(config.port).toBe(55440);
    expect(config.url).toContain("127.0.0.1:55440/hivewrightv2");
  });

  it("falls back to the real user home when task HOME has no runtime root", () => {
    expect(resolveRuntimeRoot(
      { HOME: "/tmp/hivewright-agent-home" },
      {
        userHomeDir: "/home/tester",
        osHomeDir: "/tmp/hivewright-agent-home",
        runtimeRootExists: (candidate) => candidate === "/home/tester/.hivewright",
      },
    )).toBe("/home/tester/.hivewright");
  });

  it("preserves explicit DATABASE_URL and only manages local Postgres when unset", () => {
    expect(shouldUseManagedLocalPostgres({ DATABASE_URL: "postgresql://prod/db" })).toBe(false);
    expect(shouldUseManagedLocalPostgres({ DATABASE_URL: "" })).toBe(true);
    expect(shouldUseManagedLocalPostgres({})).toBe(true);
  });

  it("rejects invalid embedded Postgres ports", () => {
    expect(() => resolveLocalPostgresConfig({ HIVEWRIGHT_EMBEDDED_POSTGRES_PORT: "nope" })).toThrow(
      "Invalid HIVEWRIGHT_EMBEDDED_POSTGRES_PORT",
    );
  });
});
