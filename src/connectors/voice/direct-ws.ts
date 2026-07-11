import type { IncomingMessage } from "node:http";
import type { Sql } from "postgres";
import type { WebSocket } from "ws";
import { db } from "@/db";
import { voiceSessions } from "@/db/schema/voice-sessions";
import { VoiceSessionRuntime } from "@/connectors/voice/runtime";
import {
  openSttClient,
  openTtsClient,
} from "@/connectors/voice/gpu-clients";
import { eaVoiceClient } from "@/ea/native/voice-adapter";
import {
  type VoiceSessionTokenPayload,
  verifyVoiceSessionRequest,
} from "@/lib/voice-session-token";
import { loadVoiceServicesUrl } from "@/lib/voice-services-url";
import type { VoiceTransport } from "./voice-transport";

const DEFAULT_DIRECT_WS_MAX_BINARY_FRAME_BYTES = 256 * 1024;
const DEFAULT_DIRECT_WS_MAX_CONTROL_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_DIRECT_WS_MAX_MESSAGES_PER_SESSION = 120_000;

const DIRECT_WS_MAX_BINARY_FRAME_BYTES = readPositiveIntEnv(
  "VOICE_WS_MAX_BINARY_FRAME_BYTES",
  DEFAULT_DIRECT_WS_MAX_BINARY_FRAME_BYTES,
);
const DIRECT_WS_MAX_CONTROL_MESSAGE_BYTES = readPositiveIntEnv(
  "VOICE_WS_MAX_CONTROL_MESSAGE_BYTES",
  DEFAULT_DIRECT_WS_MAX_CONTROL_MESSAGE_BYTES,
);
const DIRECT_WS_MAX_MESSAGES_PER_SESSION = readPositiveIntEnv(
  "VOICE_WS_MAX_MESSAGES_PER_SESSION",
  DEFAULT_DIRECT_WS_MAX_MESSAGES_PER_SESSION,
);

/**
 * Direct PCM-over-WebSocket carrier for the Voice EA.
 *
 * Replaces the Twilio Media Streams path for owners on the tailnet (the
 * PWA's only deployment surface in v1). The browser sends PCM16 mono
 * 16 kHz frames as binary; the dispatcher forwards them straight to the
 * GPU STT WebSocket without transcoding. TTS audio comes back as
 * PCM16 mono 24 kHz binary frames; the browser plays them via
 * AudioContext.
 *
 * Auth: a short-lived HMAC-signed token query-string param (see
 * `src/lib/voice-session-token.ts`). The token is minted by the
 * dashboard's `/api/voice/direct` endpoint after NextAuth gating.
 *
 * Wire protocol (browser ↔ dispatcher):
 *   - Binary inbound  → PCM16 mono 16 kHz (mic)
 *   - Binary outbound → PCM16 mono 24 kHz (TTS)
 *   - JSON outbound `{type:"session", id}` once on connect, then
 *     transcript-event frames mirrored from the existing voice events
 *     pipeline as they happen.
 *   - JSON inbound `{type:"hangup"}` requests a clean tear-down.
 */
export async function mountDirectWsHandler(
  sql: Sql,
  ws: WebSocket,
  req: IncomingMessage,
): Promise<void> {
  const payload = authenticateDirectVoiceWsRequest(req);
  if (!payload) {
    try { ws.close(1008, "policy"); } catch { /* ignore */ }
    return;
  }

  // From here we're authenticated. Set up the runtime + GPU clients.
  let runtime: VoiceSessionRuntime | null = null;
  let inboundMessageCount = 0;
  let sttClient: Awaited<ReturnType<typeof openSttClient>> | null = null;
  let ttsClient: Awaited<ReturnType<typeof openTtsClient>> | null = null;

  try {
    const voiceServicesUrl = await loadVoiceServicesUrl(sql, payload.hiveId);
    if (!voiceServicesUrl) {
      try { ws.close(1011, "voice-ea connector not configured for this hive"); } catch { /* ignore */ }
      return;
    }

    const [session] = await db
      .insert(voiceSessions)
      .values({ hiveId: payload.hiveId })
      .returning();

    sttClient = await openSttClient(voiceServicesUrl, session.id);
    ttsClient = await openTtsClient(voiceServicesUrl);

    const transport = createDirectWsTransport(ws);
    runtime = new VoiceSessionRuntime({
      hiveId: payload.hiveId,
      sessionId: session.id,
      sttClient,
      ttsClient,
      eaClient: eaVoiceClient,
      transport,
      voiceServicesUrl,
    });

    // Tell the client which session row this is. The PWA uses this id to
    // subscribe to the live transcript stream.
    try {
      ws.send(JSON.stringify({ type: "session", id: session.id }));
    } catch { /* ignore */ }

    runtime.start({ source: "direct-ws", ownerId: payload.ownerId });

    ws.on("message", (raw, isBinary) => {
      if (!runtime) return;
      inboundMessageCount += 1;
      if (inboundMessageCount > DIRECT_WS_MAX_MESSAGES_PER_SESSION) {
        try { ws.close(1008, "message limit"); } catch { /* ignore */ }
        return;
      }
      if (isBinary) {
        // Browser sends PCM16 mono 16 kHz directly. No transcoding needed.
        const buf = toBuffer(raw);
        if (buf && buf.length > DIRECT_WS_MAX_BINARY_FRAME_BYTES) {
          try { ws.close(1009, "frame too large"); } catch { /* ignore */ }
          return;
        }
        if (buf) runtime.feedMicAudio(buf);
        return;
      }
      // JSON control frame.
      try {
        const text = typeof raw === "string" ? raw : toBuffer(raw)?.toString("utf8") ?? "";
        if (!text) return;
        if (Buffer.byteLength(text, "utf8") > DIRECT_WS_MAX_CONTROL_MESSAGE_BYTES) {
          try { ws.close(1009, "control frame too large"); } catch { /* ignore */ }
          return;
        }
        const msg = JSON.parse(text);
        if (msg?.type === "hangup") {
          runtime.stop("user_hangup");
        }
      } catch (err) {
        console.error("[voice-direct-ws] bad control frame:", err);
      }
    });

    ws.on("close", () => {
      try { runtime?.stop("user_hangup"); } catch (err) {
        console.error("[voice-direct-ws] synthetic stop failed:", err);
      }
      try { sttClient?.close(); } catch { /* ignore */ }
      try { ttsClient?.close(); } catch { /* ignore */ }
    });

    ws.on("error", (err) => {
      console.error("[voice-direct-ws] socket error:", err);
      try { runtime?.stop("user_hangup"); } catch { /* runtime may already be down */ }
    });
  } catch (err) {
    console.error("[voice-direct-ws] connection setup failed:", err);
    try { ws.close(1011, "voice session setup failed"); } catch { /* ignore */ }
    try { sttClient?.close(); } catch { /* ignore */ }
    try { ttsClient?.close(); } catch { /* ignore */ }
  }
}

/**
 * Direct-WS implementation of `VoiceTransport`. PCM passthrough — the
 * browser plays the bytes via AudioContext at 24 kHz, no decoding on
 * either side.
 */
export function createDirectWsTransport(ws: WebSocket): VoiceTransport {
  let closed = false;
  return {
    sendTtsAudio(pcm24k: Buffer): void {
      if (closed) return;
      try {
        ws.send(pcm24k, { binary: true });
      } catch (err) {
        console.error("[voice-direct-ws] sendTtsAudio failed:", err);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { ws.close(1000, "session ended"); } catch { /* ignore */ }
    },
  };
}

/**
 * Pull the session token from `?token=…` (preferred) or
 * `Authorization: Bearer <token>` (fallback for tests / curl). Verify
 * via `verifyVoiceSessionToken`. Both legitimate and forged tokens
 * return `null`-vs-payload and that's the only signal we expose;
 * we don't differentiate "no token" from "bad token" in logs at gate time.
 */
export function authenticateDirectVoiceWsRequest(
  req: Pick<IncomingMessage, "url" | "headers">,
): VoiceSessionTokenPayload | null {
  return verifyVoiceSessionRequest(req);
}

function toBuffer(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]);
  return null;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
