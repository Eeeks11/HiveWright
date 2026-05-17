import { describe, expect, it } from "vitest";
import { inferRenderMode } from "@/deliverables/render-mode";

describe("inferRenderMode", () => {
  it("infers html from MIME type or extension", () => {
    expect(inferRenderMode("text/html", "deliverable.txt")).toBe("html");
    expect(inferRenderMode(null, "deliverable.html")).toBe("html");
  });

  it("infers markdown from MIME type or extension", () => {
    expect(inferRenderMode("text/markdown", "deliverable.txt")).toBe("markdown");
    expect(inferRenderMode(null, "deliverable.markdown")).toBe("markdown");
  });

  it("infers image, json, text, file, and external URLs", () => {
    expect(inferRenderMode("image/png", "generated.bin")).toBe("image");
    expect(inferRenderMode("application/json", "payload.bin")).toBe("json");
    expect(inferRenderMode(null, "payload.json")).toBe("json");
    expect(inferRenderMode("text/plain", "notes.bin")).toBe("text");
    expect(inferRenderMode("application/pdf", "brief.pdf")).toBe("file");
    expect(inferRenderMode(null, null, "external_url")).toBe("external_url");
  });
});
