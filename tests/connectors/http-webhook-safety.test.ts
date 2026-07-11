import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConnectorDefinition } from "@/connectors/registry";
import {
  setHttpWebhookDispatchForTests,
  setHttpWebhookDnsLookupForTests,
  setHttpWebhookPublicAddressPredicateForTests,
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
    setHttpWebhookPublicAddressPredicateForTests(null);
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

  it("does not retry non-idempotent HTTP webhook POST after a dispatch error", async () => {
    setHttpWebhookDnsLookupForTests(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error("socket reset after request bytes were sent"), { code: "ECONNRESET" });
    });
    setHttpWebhookDispatchForTests(dispatch);

    const operation = connectorOperation("http-webhook", "post_json");
    await expect(operation.handler({
      config: { allowedHostnames: "hooks.example.com" },
      secrets: {
        url: "https://hooks.example.com/ingest",
        authHeader: "Bearer same-side-effect-only-once",
      },
      args: { body: JSON.stringify({ sideEffect: true }) },
    })).rejects.toThrow(/connection failed for validated address 93\.184\.216\.34/);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "hooks.example.com" }),
      "93.184.216.34",
      expect.objectContaining({ method: "POST" }),
      "http-webhook",
    );
  });

  it("continues trying validated addresses for idempotent website form GET failures", async () => {
    setHttpWebhookDnsLookupForTests(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    const dispatch = vi.fn(async (_destination, address) => {
      if (address === "93.184.216.34") throw new Error("first address refused connection");
      return {
        remoteAddress: "93.184.216.35",
        response: Response.json({ submissions: [] }, { status: 200 }),
      };
    });
    setHttpWebhookDispatchForTests(dispatch);

    const operation = connectorOperation("website-forms", "sync_submissions");
    const result = await operation.handler({
      config: {
        submissionsUrl: "https://forms.example.com/submissions",
        allowedHostnames: "forms.example.com",
      },
      secrets: {
        submissionsUrl: "https://forms.example.com/submissions",
        authHeader: "Bearer read-only-can-retry",
      },
      args: {},
    });

    expect(result).toEqual({ stream: "submissions", nextCursor: undefined, items: [] });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([, address]) => address)).toEqual([
      "93.184.216.34",
      "93.184.216.35",
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

  it("uses fresh sockets for validated transport requests so remote addresses are observed on connect", async () => {
    const remotePorts: number[] = [];
    const server = http.createServer((req, res) => {
      if (typeof req.socket.remotePort === "number") remotePorts.push(req.socket.remotePort);
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "keep-alive",
      });
      res.end(JSON.stringify({ submissions: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const { port } = server.address() as AddressInfo;
      setHttpWebhookDnsLookupForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
      setHttpWebhookPublicAddressPredicateForTests((address) => address === "127.0.0.1");

      const operation = connectorOperation("website-forms", "sync_submissions");
      for (const cursor of ["first", "second"]) {
        const result = await operation.handler({
          config: {
            submissionsUrl: `http://forms.example.com:${port}/submissions`,
            allowedHostnames: "forms.example.com",
          },
          secrets: {
            submissionsUrl: `http://forms.example.com:${port}/submissions`,
          },
          args: { cursor },
        });
        expect(result).toEqual({ stream: "submissions", nextCursor: undefined, items: [] });
      }

      expect(remotePorts).toHaveLength(2);
      expect(new Set(remotePorts).size).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("aborts oversized website form responses while the validated transport is still reading chunks", async () => {
    const chunk = Buffer.alloc(128_000, "x");
    let chunksWritten = 0;
    let responseClosed = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const interval = setInterval(() => {
        chunksWritten += 1;
        res.write(chunk);
      }, 1);
      res.on("close", () => {
        responseClosed = true;
        clearInterval(interval);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const { port } = server.address() as AddressInfo;
      setHttpWebhookDnsLookupForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
      setHttpWebhookPublicAddressPredicateForTests((address) => address === "127.0.0.1");

      const operation = connectorOperation("website-forms", "sync_submissions");
      await expect(operation.handler({
        config: {
          submissionsUrl: `http://forms.example.com:${port}/submissions`,
          allowedHostnames: "forms.example.com",
        },
        secrets: {
          submissionsUrl: `http://forms.example.com:${port}/submissions`,
          authHeader: "Bearer same-authority-only",
        },
        args: {},
      })).rejects.toThrow(/website-forms response exceeded 1000000 bytes/);

      await vi.waitFor(() => expect(responseClosed).toBe(true));
      expect(chunksWritten).toBeLessThan(20);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
