import { WebSocketServer } from "ws";
import * as http from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { Sql } from "postgres";
import {
  authenticateDirectVoiceWsRequest,
  mountDirectWsHandler,
} from "@/connectors/voice/direct-ws";

/**
 * Dispatcher-hosted WebSocket server for the Voice EA.
 *
 * Single upgrade path: `/api/voice/direct/ws` carries PCM16 mono 16 kHz
 * audio frames from the PWA, and PCM16 mono 24 kHz frames back. Auth is
 * a short-lived HMAC-signed token minted by `POST /api/voice/direct` on
 * the dashboard (see `src/lib/voice-session-token.ts`).
 *
 * The pre-2026-05-07 Twilio Media Streams path (`/api/voice/ws`) was
 * removed in Phase 5 of the WebSocket cutover plan; nothing left in this
 * server is Twilio-aware.
 */

export interface VoiceWsHandle {
  /** Underlying HTTP server. Tests use this for `.address()` and `.once('listening')`. */
  server: HttpServer;
  wss: WebSocketServer;
  shutdown(): Promise<void>;
}

const DIRECT_PATH = "/api/voice/direct/ws";
const VOICE_WS_HANDSHAKE_TIMEOUT_MS = 5_000;
const VOICE_WS_MAX_CONNECTIONS = readPositiveIntEnv(
  "VOICE_WS_MAX_CONNECTIONS",
  25,
);
const VOICE_WS_MAX_PAYLOAD_BYTES = readPositiveIntEnv(
  "VOICE_WS_MAX_BINARY_FRAME_BYTES",
  256 * 1024,
);

export function startVoiceWsServer(sql: Sql, port: number): VoiceWsHandle {
  // noServer mode so we can route on URL path before deciding to upgrade.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: VOICE_WS_MAX_PAYLOAD_BYTES,
  });

  const server = http.createServer((_req, res) => {
    res.statusCode = 426;
    res.end("upgrade required");
  });
  server.on("upgrade", (req, socket, head) => {
    const netSocket = socket as Socket;
    netSocket.setTimeout(VOICE_WS_HANDSHAKE_TIMEOUT_MS, () => netSocket.destroy());

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      rejectUpgrade(netSocket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== DIRECT_PATH) {
      socket.destroy();
      return;
    }
    if (!authenticateDirectVoiceWsRequest(req)) {
      rejectUpgrade(netSocket, 401, "Unauthorized");
      return;
    }
    if (wss.clients.size >= VOICE_WS_MAX_CONNECTIONS) {
      rejectUpgrade(netSocket, 503, "Service Unavailable");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      netSocket.setTimeout(0);
      void mountDirectWsHandler(sql, ws, req);
    });
  });
  server.listen(port);

  wss.on("error", (err) => {
    console.error("[voice-ws] server error:", err);
  });

  return {
    server,
    wss,
    async shutdown() {
      for (const client of wss.clients) {
        try {
          client.close(1001, "shutting down");
        } catch { /* ignore */ }
      }
      return new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
        });
      });
    },
  };
}

function rejectUpgrade(
  socket: Pick<Socket, "destroy" | "write" | "writable" | "setTimeout">,
  statusCode: number,
  statusText: string,
): void {
  socket.setTimeout(0);
  try {
    if (socket.writable) {
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n",
      );
    }
  } catch { /* ignore */ }
  socket.destroy();
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
