import { afterEach, describe, expect, it, vi } from "vitest";
import { getConnectorDefinition } from "@/connectors/registry";
import {
  setHttpWebhookDispatchForTests,
  setHttpWebhookDnsLookupForTests,
} from "@/connectors/http-webhook-safety";

function connectorOperation(connectorSlug: string, operationSlug: string) {
  const connector = getConnectorDefinition(connectorSlug);
  const operation = connector?.operations.find((candidate) => candidate.slug === operationSlug);
  if (!operation) throw new Error(`missing ${connectorSlug}.${operationSlug}`);
  return operation;
}

describe("HTTP connector SSRF safety", () => {
  afterEach(() => {
    setHttpWebhookDnsLookupForTests(null);
    setHttpWebhookDispatchForTests(null);
    vi.restoreAllMocks();
  });

  it("posts generic HTTP webhooks through the validated public address without a second hostname fetch", async () => {
    setHttpWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not be used"));
    const dispatched: Array<{ address: string; headers?: Record<string, string>; body?: string | Uint8Array }> = [];
    setHttpWebhookDispatchForTests(async (destination, address, options) => {
      dispatched.push({ address, headers: options.headers, body: options.body });
      expect(destination.hostname).toBe("hooks.example.com");
      return {
        remoteAddress: "93.184.216.34",
        response: Response.json({ ok: true }, { status: 200 }),
      };
    });

    const operation = connectorOperation("http-webhook", "post_json");
    const result = await operation.handler({
      config: { allowedHostnames: "hooks.example.com" },
      secrets: {
        url: "https://hooks.example.com/ingest",
        authHeader: "Bearer should-stay-on-validated-transport",
      },
      args: { body: JSON.stringify({ hello: "world" }) },
    });

    expect(result).toEqual({ status: 200, data: { ok: true }, hostname: "hooks.example.com" });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(dispatched).toEqual([
      {
        address: "93.184.216.34",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer should-stay-on-validated-transport",
        },
        body: JSON.stringify({ hello: "world" }),
      },
    ]);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["RFC1918", "10.0.0.5"],
    ["cloud metadata", "169.254.169.254"],
  ])("blocks generic HTTP webhook DNS rebinding to %s before dispatching authorization", async (_label, address) => {
    setHttpWebhookDnsLookupForTests(async () => [{ address, family: 4 }]);
    const dispatch = vi.fn();
    setHttpWebhookDispatchForTests(dispatch);

    const operation = connectorOperation("http-webhook", "post_json");
    await expect(operation.handler({
      config: { allowedHostnames: "hooks.example.com" },
      secrets: {
        url: "https://hooks.example.com/ingest",
        authHeader: "Bearer must-not-leave-process",
      },
      args: { body: JSON.stringify({ unsafe: true }) },
    })).rejects.toThrow(/unsafe address/);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["RFC1918", "192.168.1.10"],
    ["cloud metadata", "169.254.169.254"],
  ])("blocks website form DNS rebinding to %s before dispatching authorization", async (_label, address) => {
    setHttpWebhookDnsLookupForTests(async () => [{ address, family: 4 }]);
    const dispatch = vi.fn();
    setHttpWebhookDispatchForTests(dispatch);

    const operation = connectorOperation("website-forms", "sync_submissions");
    await expect(operation.handler({
      config: {
        submissionsUrl: "https://forms.example.com/submissions",
        allowedHostnames: "forms.example.com",
      },
      secrets: {
        submissionsUrl: "https://forms.example.com/submissions",
        authHeader: "Bearer must-not-leave-process",
      },
      args: {},
    })).rejects.toThrow(/unsafe address/);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a connected socket address that does not match the validated public DNS answer", async () => {
    setHttpWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setHttpWebhookDispatchForTests(async () => ({
      remoteAddress: "127.0.0.1",
      response: Response.json({ ok: true }, { status: 200 }),
    }));

    const operation = connectorOperation("http-webhook", "post_json");
    await expect(operation.handler({
      config: { allowedHostnames: "hooks.example.com" },
      secrets: {
        url: "https://hooks.example.com/ingest",
        authHeader: "Bearer same-authority-only",
      },
      args: { body: "{}" },
    })).rejects.toThrow(/unvalidated address 127\.0\.0\.1/);
  });

  it("keeps website form redirects blocked when using the validated transport", async () => {
    setHttpWebhookDnsLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setHttpWebhookDispatchForTests(async () => ({
      remoteAddress: "93.184.216.34",
      response: new Response(null, {
        status: 302,
        headers: { Location: "https://other.example.com/private" },
      }),
    }));

    const operation = connectorOperation("website-forms", "sync_submissions");
    await expect(operation.handler({
      config: {
        submissionsUrl: "https://forms.example.com/submissions",
        allowedHostnames: "forms.example.com",
      },
      secrets: {
        submissionsUrl: "https://forms.example.com/submissions",
        authHeader: "Bearer same-authority-only",
      },
      args: {},
    })).rejects.toThrow(/redirects are not allowed/);
  });
});
