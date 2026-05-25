import { describe, expect, it } from "vitest";
import { settingsToSetupRedirects } from "../../src/navigation/setup-redirects";

describe("settings to setup redirects", () => {
  it("does not redirect active global settings routes back into Hive Setup", () => {
    const redirectedSources = settingsToSetupRedirects.map((redirect) => redirect.source);

    expect(redirectedSources).not.toContain("/settings");
    expect(redirectedSources).not.toContain("/settings/adapters");
    expect(redirectedSources).not.toContain("/settings/embeddings");
    expect(redirectedSources).not.toContain("/settings/work-intake");
  });

  it("keeps only legacy settings setup paths that do not have current global navigation entries", () => {
    expect(settingsToSetupRedirects).toEqual(
      expect.arrayContaining([
        { source: "/settings/connectors", destination: "/setup/connectors", permanent: true },
        { source: "/settings/setup-health", destination: "/setup/health", permanent: true },
        { source: "/settings/health", destination: "/setup/health", permanent: true },
        { source: "/settings/workflow-capture", destination: "/setup/workflow-capture", permanent: true },
        { source: "/settings/workflow-capture/:path*", destination: "/setup/workflow-capture/:path*", permanent: true },
        { source: "/settings/sop-importer", destination: "/setup/sop-importer", permanent: true },
      ]),
    );
  });
});
