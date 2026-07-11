import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = {
  scripts?: Record<string, string>;
};

describe("production build contract", () => {
  it("uses webpack for both canonical Next.js production builds so Serwist emits the service worker", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as PackageJson;

    expect(packageJson.scripts?.build).toBe("next build --webpack");
    expect(packageJson.scripts?.["build:runtime"]).toBe(
      "scripts/with-runtime-env.sh next build --webpack",
    );
  });
});
