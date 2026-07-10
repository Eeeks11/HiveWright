import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { signVoiceSessionToken } from "@/lib/voice-session-token";

const mocks = vi.hoisted(() => ({
  mountDirectWsHandler: vi.fn(),
}));

vi.mock("@/connectors/voice/direct-ws", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice-session-token")>(
    "@/lib/voice-session-token",
  );
  return {
    authenticateDirectVoiceWsRequest: actual.verifyVoiceSessionRequest,
    mountDirectWsHandler: mocks.mountDirectWsHandler,
  };
});

import { startVoiceWsServer } from "@/dispatcher/voice-ws-server";

class FakeSocket extends EventEmitter {
  writable = true;
  writes: string[] = [];
  destroyed = false;
  timeoutMs: number | undefined;

  write(chunk: string | Buffer): boolean {
    this.writes.push(String(chunk));
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  setTimeout(ms: number, cb?: () => void): this {
    this.timeoutMs = ms;
    if (cb) this.once("timeout", cb);
    return this;
  }
}

function fakeUpgradeRequest(url: string): IncomingMessage {
  return {
    url,
    headers: {
      host: "voice.example.ts.net",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": ["dGhlIHNhbXBsZ", "SBub25jZQ=="].join(""),
      "sec-websocket-version": "13",
    },
  } as unknown as IncomingMessage;
}

const fakeSql = (() => Promise.resolve([])) as unknown as Parameters<
  typeof startVoiceWsServer
>[0];

describe("startVoiceWsServer upgrade auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_SERVICE_TOKEN = "test-secret-do-not-ship";
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("rejects unauthenticated direct-voice upgrades before handleUpgrade", async () => {
    const handle = startVoiceWsServer(fakeSql, 0);
    const handleUpgrade = vi.spyOn(handle.wss, "handleUpgrade");
    const socket = new FakeSocket();

    handle.server.emit(
      "upgrade",
      fakeUpgradeRequest("/api/voice/direct/ws"),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );

    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(mocks.mountDirectWsHandler).not.toHaveBeenCalled();
    expect(socket.writes.join("")).toContain("HTTP/1.1 401 Unauthorized");
    expect(socket.destroyed).toBe(true);

    await handle.shutdown();
  });

  it("does not let unauthenticated upgrade floods reach handleUpgrade", async () => {
    const handle = startVoiceWsServer(fakeSql, 0);
    const handleUpgrade = vi.spyOn(handle.wss, "handleUpgrade");
    const sockets = Array.from({ length: 50 }, () => new FakeSocket());

    for (const socket of sockets) {
      handle.server.emit(
        "upgrade",
        fakeUpgradeRequest("/api/voice/direct/ws"),
        socket as unknown as Socket,
        Buffer.alloc(0),
      );
    }

    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(mocks.mountDirectWsHandler).not.toHaveBeenCalled();
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);

    await handle.shutdown();
  });

  it("hands authorized direct-voice upgrades to the websocket server", async () => {
    const handle = startVoiceWsServer(fakeSql, 0);
    const ws = { close: vi.fn() };
    const handleUpgrade = vi
      .spyOn(handle.wss, "handleUpgrade")
      .mockImplementation((req, _socket, _head, cb) => cb(ws as never, req));
    const token = signVoiceSessionToken({ hiveId: "hive-1", ownerId: "owner-1" });
    const socket = new FakeSocket();

    handle.server.emit(
      "upgrade",
      fakeUpgradeRequest(`/api/voice/direct/ws?token=${encodeURIComponent(token)}`),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );

    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    expect(mocks.mountDirectWsHandler).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
    expect(socket.timeoutMs).toBe(0);

    await handle.shutdown();
  });

  it("rejects authorized upgrades when the connection cap is already reached", async () => {
    const handle = startVoiceWsServer(fakeSql, 0);
    const handleUpgrade = vi.spyOn(handle.wss, "handleUpgrade");
    const token = signVoiceSessionToken({ hiveId: "hive-1", ownerId: "owner-1" });
    for (let i = 0; i < 25; i += 1) {
      handle.wss.clients.add({ close: vi.fn() } as never);
    }
    const socket = new FakeSocket();

    handle.server.emit(
      "upgrade",
      fakeUpgradeRequest(`/api/voice/direct/ws?token=${encodeURIComponent(token)}`),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );

    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(socket.writes.join("")).toContain("HTTP/1.1 503 Service Unavailable");
    expect(socket.destroyed).toBe(true);

    handle.wss.clients.clear();
    await handle.shutdown();
  });
});
