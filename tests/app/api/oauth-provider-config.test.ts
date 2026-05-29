import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireSystemOwner: vi.fn(async (): Promise<
    | { user: { id: string; email: string; isSystemOwner: boolean } }
    | { response: NextResponse }
  > => ({
    user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
  })),
  defaultEnvFilePath: vi.fn(() => "/tmp/hivewright-test.env"),
  upsertEnvFileValue: vi.fn((key: string) => ({
    envFilePath: "/tmp/hivewright-test.env",
    updated: key === "GOOGLE_CLIENT_ID",
  })),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/lib/env-file", () => ({
  defaultEnvFilePath: mocks.defaultEnvFilePath,
  upsertEnvFileValue: mocks.upsertEnvFileValue,
}));

import { GET, PATCH } from "@/app/api/oauth/provider-config/route";

const originalEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  PORT: process.env.PORT,
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  process.env.PUBLIC_BASE_URL = "https://hive.example.test";
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("/api/oauth/provider-config", () => {
  it("reports Google OAuth provider setup without exposing secret values", async () => {
    process.env.GOOGLE_CLIENT_ID = "client-id-123";
    process.env.GOOGLE_CLIENT_SECRET = "secret-456";

    const res = await GET(new Request("http://localhost/api/oauth/provider-config"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      provider: "google",
      configured: true,
      clientIdPresent: true,
      clientSecretPresent: true,
      clientIdPreview: "client…-123",
      redirectUri: "https://hive.example.test/api/oauth/callback",
      envFilePath: "/tmp/hivewright-test.env",
    });
    expect(JSON.stringify(body)).not.toContain("secret-456");
  });

  it("lets a system owner save Google OAuth app config from the dashboard", async () => {
    const res = await PATCH(new Request("http://localhost/api/oauth/provider-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        clientId: "new-client-id.apps.googleusercontent.com",
        clientSecret: "new-client-secret",
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.upsertEnvFileValue).toHaveBeenCalledWith(
      "GOOGLE_CLIENT_ID",
      "new-client-id.apps.googleusercontent.com",
    );
    expect(mocks.upsertEnvFileValue).toHaveBeenCalledWith(
      "GOOGLE_CLIENT_SECRET",
      "new-client-secret",
    );
    expect(process.env.GOOGLE_CLIENT_ID).toBe("new-client-id.apps.googleusercontent.com");
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe("new-client-secret");
    expect(body.data).toMatchObject({
      provider: "google",
      configured: true,
      restartRequired: false,
    });
    expect(JSON.stringify(body)).not.toContain("new-client-secret");
  });

  it("requires system owner access to save OAuth app config", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: NextResponse.json(
        { error: "Forbidden: system owner role required" },
        { status: 403 },
      ),
    });

    const res = await PATCH(new Request("http://localhost/api/oauth/provider-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        clientId: "client-id",
        clientSecret: "secret",
      }),
    }));

    expect(res.status).toBe(403);
    expect(mocks.upsertEnvFileValue).not.toHaveBeenCalled();
  });

  it("rejects incomplete Google OAuth app config", async () => {
    const res = await PATCH(new Request("http://localhost/api/oauth/provider-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google", clientId: "client-id" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("clientSecret is required");
    expect(mocks.upsertEnvFileValue).not.toHaveBeenCalled();
  });
});
