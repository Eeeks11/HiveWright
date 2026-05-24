import { describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/health/route";

describe("GET /api/health", () => {
  it("returns a minimal alive response without secrets", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "super-secret-token";

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      status: "ok",
      service: "hivewright",
    });
    expect(body.data.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(body)).not.toContain("super-secret-token");
  });
});
