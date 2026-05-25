import { describe, expect, it } from "vitest";
import { DEMO_DELIVERABLES, MANUAL_QA_CHECKLIST } from "../../scripts/setup-deliverables-demo-fixture";

describe("setup-deliverables-demo-fixture", () => {
  it("documents the phase 8 deliverable mix and manual QA coverage", () => {
    expect(DEMO_DELIVERABLES.map((item) => item.kind).sort()).toEqual([
      "file",
      "html",
      "image",
      "markdown",
    ]);
    expect(DEMO_DELIVERABLES.every((item) => item.filename && item.mimeType && item.renderMode)).toBe(true);

    expect(MANUAL_QA_CHECKLIST).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Local desktop browser can open /deliverables"),
        expect.stringContaining("Tailscale browser can open"),
        expect.stringContaining("Mobile browser can open"),
        expect.stringContaining("Open buttons work"),
        expect.stringContaining("Copy link produces a current-origin URL"),
        expect.stringContaining("Generated HTML"),
        expect.stringContaining("Unauthorized user cannot access"),
      ]),
    );
  });
});
