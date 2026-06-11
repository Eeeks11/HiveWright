import { describe, expect, it } from "vitest";
import {
  buildRuntimeBuildCommands,
  buildRuntimeCutoverConfig,
  buildRuntimeDeploymentProvenance,
  renderDashboardUserService,
  renderDispatcherLegacyGuard,
  renderDispatcherUserService,
} from "@/system/runtime-cutover";

describe("runtime cutover", () => {
  const config = buildRuntimeCutoverConfig({
    serviceUser: "trent",
    runtimeCheckout: "/home/trent/apps/HiveWright",
    runtimeRoot: "/home/trent/.hivewright",
    serviceDirectory: "/home/trent/.config/systemd/user",
  });

  it("refuses to render services against a writable runtime checkout", () => {
    expect(() =>
      buildRuntimeCutoverConfig({
        serviceUser: "trent",
        runtimeCheckout: "/home/trent/dev/hivewright-live",
        runtimeRoot: "/home/trent/.hivewright",
        serviceDirectory: "/home/trent/.config/systemd/user",
      }),
    ).toThrow(/locked operational install/);
  });

  it("renders dashboard service against the locked operational install", () => {
    const unit = renderDashboardUserService(config);

    expect(unit).toContain("WorkingDirectory=/home/trent/apps/HiveWright");
    expect(unit).toContain("ExecStart=/usr/bin/npm run start -- -H 127.0.0.1");
    expect(unit).toContain("Environment=HIVEWRIGHT_RUNTIME_ROOT=/home/trent/.hivewright");
    expect(unit).toContain("Environment=HIVEWRIGHT_SECRETS_FILE=/home/trent/.hivewright/secrets.env");
    expect(unit).not.toContain("/home/trent/dev/hivewright-live");
  });

  it("renders dispatcher service and cwd guard against the locked operational install", () => {
    const unit = renderDispatcherUserService(config);
    const guard = renderDispatcherLegacyGuard(config);

    expect(unit).toContain("WorkingDirectory=/home/trent/apps/HiveWright");
    expect(unit).toContain("ExecStart=/bin/bash /home/trent/apps/HiveWright/start-dispatcher.sh");
    expect(unit).toContain("Environment=HIVEWRIGHT_SECRETS_FILE=/home/trent/.hivewright/secrets.env");
    expect(guard).toContain('test "$PWD" = "/home/trent/apps/HiveWright"');
    expect(guard).toContain("HiveWright dispatcher must run from locked install /home/trent/apps/HiveWright");
    expect(guard).not.toContain("/home/trent/dev/hivewright-live");
  });

  it("records deployment provenance for the locked operational install", () => {
    const provenance = buildRuntimeDeploymentProvenance(config, {
      sourceRepo: "/home/trent/apps/HiveWright",
      requestedRef: "origin/main",
      deployedCommit: "abc123def456",
      deployedAt: "2026-06-09T06:30:00.000Z",
      readinessUrl: "http://127.0.0.1:3002/api/readiness",
    });

    expect(provenance.runtimeCheckout).toBe("/home/trent/apps/HiveWright");
    expect(provenance.sourceRepo).toBe("/home/trent/apps/HiveWright");
    expect(provenance.deployedCommit).toBe("abc123def456");
    expect(provenance.systemd.dashboardUnit).toBe("/home/trent/.config/systemd/user/hivewright-dashboard.service");
    expect(provenance.systemd.dispatcherUnit).toBe("/home/trent/.config/systemd/user/hivewright-dispatcher.service");
  });

  it("includes dev dependencies in the runtime cutover build plan", () => {
    expect(buildRuntimeBuildCommands()).toEqual([
      ["npm", ["install", "--include=dev"]],
      ["npm", ["run", "db:migrate:app"]],
      ["npm", ["run", "build:runtime"]],
      ["npm", ["run", "build:dispatcher"]],
    ]);
  });
});
