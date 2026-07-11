import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  bootstrapFirstOwner: vi.fn(),
  removeOwnerSetupTokenFromSecrets: vi.fn(),
  runtimeSecretsPath: vi.fn(() => "/runtime/secrets.env"),
}));

vi.mock("../../_lib/db", () => ({ sql: mocks.sql }));
vi.mock("@/auth/owner-bootstrap", () => ({
  bootstrapFirstOwner: mocks.bootstrapFirstOwner,
}));
vi.mock("@/auth/owner-bootstrap-provisioning", () => ({
  removeOwnerSetupTokenFromSecrets: mocks.removeOwnerSetupTokenFromSecrets,
  runtimeSecretsPath: mocks.runtimeSecretsPath,
}));

import { POST } from "./route";

const SECRET_TOKEN = "raw-super-secret-setup-token";
const PASSWORD = "raw-super-secret-password";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/auth/bootstrap-owner", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "192.0.2.7" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/bootstrap-owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["missing", "", "denied"],
    ["wrong", "wrong-token", "denied"],
    ["reused", SECRET_TOKEN, "denied"],
    ["rate limited", SECRET_TOKEN, "rate_limited"],
  ])("returns the same non-enumerating response for %s proof", async (_case, setupToken, reason) => {
    mocks.bootstrapFirstOwner.mockResolvedValue({ ok: false, reason });
    const response = await POST(request({
      email: "owner@example.test",
      password: PASSWORD,
      setupToken,
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Unable to create owner account." });
    expect(mocks.bootstrapFirstOwner).toHaveBeenCalledWith(mocks.sql, expect.objectContaining({
      setupToken,
      source: "192.0.2.7",
    }));
  });

  it("returns only the owner projection and scrubs the local token after success", async () => {
    mocks.bootstrapFirstOwner.mockResolvedValue({
      ok: true,
      user: {
        id: "user-1",
        email: "owner@example.test",
        displayName: "Owner",
        isSystemOwner: true,
      },
    });
    const response = await POST(request({
      email: "owner@example.test",
      password: PASSWORD,
      setupToken: SECRET_TOKEN,
    }));
    expect(response.status).toBe(201);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(PASSWORD);
    expect(mocks.removeOwnerSetupTokenFromSecrets).toHaveBeenCalledWith("/runtime/secrets.env");
  });

  it("does not leak request secrets through errors, responses, or logs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.bootstrapFirstOwner.mockRejectedValue(new Error(`${SECRET_TOKEN} ${PASSWORD}`));
    const response = await POST(request({ setupToken: SECRET_TOKEN, password: PASSWORD }));
    const combined = JSON.stringify(await response.json()) + JSON.stringify(errorSpy.mock.calls);
    expect(response.status).toBe(403);
    expect(combined).not.toContain(SECRET_TOKEN);
    expect(combined).not.toContain(PASSWORD);
    errorSpy.mockRestore();
  });
});
