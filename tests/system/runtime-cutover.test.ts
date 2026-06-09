import { describe, expect, it } from "vitest";
import {
  buildRuntimeCutoverConfig,
  buildRuntimeDeploymentProvenance,
  renderDashboardUserService,
  renderDispatcherLegacyGuard,
  renderDispatcherUserService,
} from "@/system/runtime-cutover";

describe("runtime cutover", () => {
  const config = buildRuntimeCutoverConfig({
    serviceUser: "trent",
    runtimeCheckout: "/home/trent/dev/hivewright-live",
    runtimeRoot: "/home/trent/.hivewright",
    serviceDirectory: "/home/trent/.config/systemd/user",
  });

  it("renders dashboard service against the writable runtime checkout", () => {
    const unit = renderDashboardUserService(config);

    expect(unit).toContain("WorkingDirectory=/home/trent/dev/hivewright-live");
    expect(unit).toContain("ExecStart=/usr/bin/npm run start -- -H 127.0.0.1");
    expect(unit).toContain("Environment=HIVEWRIGHT_RUNTIME_ROOT=/home/trent/.hivewright");
    expect(unit).not.toContain("/home/trent/apps/HiveWright");
  });

  it("renders dispatcher service and cwd guard against the same checkout", () => {
    const unit = renderDispatcherUserService(config);
    const guard = renderDispatcherLegacyGuard(config);

    expect(unit).toContain("WorkingDirectory=/home/trent/dev/hivewright-live");
    expect(unit).toContain("ExecStart=/bin/bash /home/trent/dev/hivewright-live/start-dispatcher.sh");
    expect(guard).toContain('test "$PWD" = "/home/trent/dev/hivewright-live"');
    expect(guard).not.toContain("/home/trent/apps/HiveWright");
  });

  it("records deployment provenance for the live runtime checkout", () => {
    const provenance = buildRuntimeDeploymentProvenance(config, {
      sourceRepo: "/home/trent/dev/hivewright",
      requestedRef: "hw/task/a56fa581-infrastructure-agent",
      deployedCommit: "abc123def456",
      deployedAt: "2026-06-09T06:30:00.000Z",
      readinessUrl: "http://127.0.0.1:3002/api/readiness",
    });

    expect(provenance.runtimeCheckout).toBe("/home/trent/dev/hivewright-live");
    expect(provenance.sourceRepo).toBe("/home/trent/dev/hivewright");
    expect(provenance.deployedCommit).toBe("abc123def456");
    expect(provenance.systemd.dashboardUnit).toBe("/home/trent/.config/systemd/user/hivewright-dashboard.service");
    expect(provenance.systemd.dispatcherUnit).toBe("/home/trent/.config/systemd/user/hivewright-dispatcher.service");
  });
});
