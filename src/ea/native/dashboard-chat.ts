import type { Sql } from "postgres";
import { sql as appSql } from "@/app/api/_lib/db";
import {
  appendMessage,
  closeActiveThread,
  getOrCreateActiveThread,
  getThreadMessages,
  type EaMessage,
  type EaThread,
} from "./thread-store";
import { buildEaPrompt } from "./prompt";
import { runEaStream } from "./runner";
import { recordEaModelRouteTelemetry, resolveEaModelRoute } from "./model-selection";
import { emitEaChatEvent } from "./events";
import { scheduleImplicitQualityExtraction } from "@/quality/ea-post-turn";
import { type EaAttachment, renderEaAttachmentSection } from "./attachments";

export type DashboardChatMessage = EaMessage;

const DEFAULT_API_BASE_URL = "http://localhost:3002";

export interface DashboardChatState {
  thread: EaThread;
  messages: DashboardChatMessage[];
  hasMore: boolean;
}

export interface DashboardSendResult {
  thread: EaThread;
  threadId: string;
  ownerMessage: DashboardChatMessage;
  assistantMessage: DashboardChatMessage;
}

export class DashboardEaTurnInProgressError extends Error {
  constructor(
    readonly threadId: string,
    readonly assistantMessageId: string,
  ) {
    super("EA is already responding");
    this.name = "DashboardEaTurnInProgressError";
  }
}

export interface DashboardEaSubmitContext {
  hiveId: string;
  hiveName?: string;
  attachments?: EaAttachment[];
  signal?: AbortSignal;
}

export interface DashboardEaClient {
  submit(text: string, ctx: DashboardEaSubmitContext): Promise<DashboardEaStream>;
}

export type DashboardEaFailureCategory =
  | "aborted"
  | "runner_failure"
  | "empty_output"
  | "preparation_failure";

export interface DashboardEaStream extends AsyncIterable<string> {
  threadId: string;
  assistantMessageId: string;
}

export class DashboardEaStreamError extends Error {
  constructor(
    readonly category: DashboardEaFailureCategory,
    readonly threadId: string,
    readonly assistantMessageId: string,
    message = "Dashboard EA stream failed",
  ) {
    super(message);
    this.name = "DashboardEaStreamError";
  }
}

const SAFE_FAILURE_MESSAGES: Record<DashboardEaFailureCategory, string> = {
  aborted: "EA response was interrupted before completion.",
  runner_failure: "EA response failed before completion.",
  empty_output: "EA returned no response.",
  preparation_failure: "EA response could not be started.",
};

export function dashboardChannelId(hiveId: string): string {
  return `dashboard:${hiveId}`.slice(0, 64);
}

async function prepareDashboardTurn(
  sql: Sql,
  input: {
    hiveId: string;
    hiveName?: string;
    content: string;
    attachments?: EaAttachment[];
    signal?: AbortSignal;
  },
): Promise<{
  thread: EaThread;
  ownerMessage: EaMessage;
  assistantMessage: EaMessage;
  stream: DashboardEaStream;
}> {
  const thread = await getOrCreateActiveThread(
    sql,
    input.hiveId,
    dashboardChannelId(input.hiveId),
  );

  const [running] = await sql<{ id: string }[]>`
    SELECT id
    FROM ea_messages
    WHERE thread_id = ${thread.id}
      AND role = 'assistant'
      AND status = 'streaming'
    LIMIT 1
  `;
  if (running) {
    throw new DashboardEaTurnInProgressError(thread.id, running.id);
  }
  const attachments = input.attachments ?? [];
  const attachmentSection = renderEaAttachmentSection(attachments);
  const persistedOwnerContent = attachmentSection
    ? `${input.content}\n${attachmentSection}`
    : input.content;

  const ownerMessage = await appendMessage(
    sql,
    thread.id,
    "owner",
    persistedOwnerContent,
    null,
    "dashboard",
  );
  await emitEaChatEvent(sql, {
    type: "ea_message_created",
    hiveId: input.hiveId,
    threadId: thread.id,
    messageId: ownerMessage.id,
  });

  const assistantMessage = await appendMessage(
    sql,
    thread.id,
    "assistant",
    "",
    null,
    "dashboard",
    null,
    "streaming",
  );
  await emitEaChatEvent(sql, {
    type: "ea_message_created",
    hiveId: input.hiveId,
    threadId: thread.id,
    messageId: assistantMessage.id,
  });

  const streamController = new AbortController();
  const signal = linkAbortSignals(input.signal, streamController.signal);
  let eaStream: AsyncIterable<string>;
  try {
    const [hive] = await sql<{ name: string }[]>`
      SELECT name FROM hives WHERE id = ${input.hiveId}
    `;
    // Failed/partial output remains available to the owner for diagnosis, but
    // is not replayed as if it were a completed assistant answer.
    const history = (await getThreadMessages(sql, thread.id)).filter(
      (message) => message.id !== assistantMessage.id && message.status === "sent",
    );
    const apiBaseUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.NEXT_PUBLIC_DASHBOARD_URL ??
      DEFAULT_API_BASE_URL;
    const prompt = await buildEaPrompt(sql, {
      hiveId: input.hiveId,
      hiveName: input.hiveName ?? hive?.name ?? "unknown",
      history,
      currentOwnerMessage: input.content,
      apiBaseUrl,
      auditContext: {
        source: "dashboard",
        sourceHiveId: input.hiveId,
        threadId: thread.id,
        ownerMessageId: ownerMessage.id,
      },
    });
    const promptWithAttachments = attachments.length > 0
      ? `${prompt}\n${attachmentSection}`
      : prompt;
    const route = await resolveEaModelRoute(sql, input.hiveId);
    await recordEaModelRouteTelemetry(sql, {
      hiveId: input.hiveId,
      transport: "dashboard",
      route,
    });
    eaStream = runEaStream(promptWithAttachments, {
      signal,
      attachmentPaths: attachments.map((attachment) => attachment.absolutePath),
      model: route.model,
    });
  } catch {
    await finalizeAssistantMessage(sql, assistantMessage.id, {
      content: "",
      status: "failed",
      error: SAFE_FAILURE_MESSAGES.preparation_failure,
    });
    throw new DashboardEaStreamError(
      "preparation_failure",
      thread.id,
      assistantMessage.id,
    );
  }

  const generator = (async function* () {
    let accumulated = "";
    let completed = false;
    let finalized = false;
    try {
      try {
        for await (const chunk of eaStream) {
          accumulated += chunk;
          yield chunk;
        }
      } catch (error) {
        const category = signal.aborted || isAbortError(error)
          ? "aborted"
          : "runner_failure";
        await finalizeAssistantMessage(sql, assistantMessage.id, {
          content: accumulated,
          status: "failed",
          error: SAFE_FAILURE_MESSAGES[category],
        });
        finalized = true;
        throw new DashboardEaStreamError(category, thread.id, assistantMessage.id);
      }

      if (signal.aborted) {
        await finalizeAssistantMessage(sql, assistantMessage.id, {
          content: accumulated,
          status: "failed",
          error: SAFE_FAILURE_MESSAGES.aborted,
        });
        finalized = true;
        throw new DashboardEaStreamError("aborted", thread.id, assistantMessage.id);
      }

      if (accumulated.trim().length === 0) {
        await finalizeAssistantMessage(sql, assistantMessage.id, {
          content: accumulated,
          status: "failed",
          error: SAFE_FAILURE_MESSAGES.empty_output,
        });
        finalized = true;
        throw new DashboardEaStreamError(
          "empty_output",
          thread.id,
          assistantMessage.id,
          "EA returned an empty response",
        );
      }

      await finalizeAssistantMessage(sql, assistantMessage.id, {
        content: accumulated,
        status: "sent",
        error: null,
      });
      finalized = true;
      completed = true;
      scheduleImplicitQualityExtraction(sql, {
        hiveId: input.hiveId,
        ownerMessage: input.content,
        ownerMessageId: ownerMessage.id,
      });
    } finally {
      if (!completed) {
        streamController.abort();
      }
      // Consumer cancellation (for example navigation away) calls return()
      // on the generator rather than throwing through the loop. Preserve any
      // partial owner-visible text, but never present it as a complete answer.
      if (!finalized) {
        await finalizeAssistantMessage(sql, assistantMessage.id, {
          content: accumulated,
          status: "failed",
          error: SAFE_FAILURE_MESSAGES.aborted,
        });
      }
    }
  })();
  const stream = Object.assign(generator, {
    threadId: thread.id,
    assistantMessageId: assistantMessage.id,
  });

  return { thread, ownerMessage, assistantMessage, stream };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function finalizeAssistantMessage(
  sql: Sql,
  messageId: string,
  input: { content: string; status: "sent" | "failed"; error: string | null },
): Promise<EaMessage | undefined> {
  const [message] = await sql<EaMessage[]>`
    UPDATE ea_messages AS target
    SET content = ${input.content},
        status = ${input.status},
        error = ${input.error},
        updated_at = NOW()
    WHERE target.id = ${messageId}
      AND target.status = 'streaming'
    RETURNING id, thread_id as "threadId", role, content,
              discord_message_id as "discordMessageId",
              source,
              voice_session_id as "voiceSessionId",
              status,
              error,
              created_at as "createdAt",
              updated_at as "updatedAt"
  `;
  return message;
}

function linkAbortSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (!external) return internal;
  return AbortSignal.any([external, internal]);
}

export const dashboardEaClient: DashboardEaClient = {
  async submit(text, ctx) {
    const turn = await prepareDashboardTurn(appSql, {
      hiveId: ctx.hiveId,
      hiveName: ctx.hiveName,
      content: text,
      attachments: ctx.attachments,
      signal: ctx.signal,
    });
    return turn.stream;
  },
};

export async function getDashboardChat(
  sql: Sql,
  input: {
    hiveId: string;
    userId: string;
    limit?: number;
    before?: string | null;
  },
): Promise<DashboardChatState> {
  const thread = await getOrCreateActiveThread(
    sql,
    input.hiveId,
    dashboardChannelId(input.hiveId),
  );
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 80);
  const rows = await sql<DashboardChatMessage[]>`
    SELECT id, thread_id as "threadId", role, content,
           discord_message_id as "discordMessageId",
           source,
           voice_session_id as "voiceSessionId",
           status,
           error,
           created_at as "createdAt",
           updated_at as "updatedAt"
    FROM ea_messages
    WHERE thread_id = ${thread.id}
      AND (${input.before ?? null}::timestamp IS NULL OR created_at < ${input.before ?? null}::timestamp)
    ORDER BY created_at DESC
    LIMIT ${limit + 1}
  `;

  return {
    thread,
    messages: rows.slice(0, limit).reverse(),
    hasMore: rows.length > limit,
  };
}

export const getDashboardEaThreadWithMessages = getDashboardChat;

export async function startFreshDashboardThread(
  sql: Sql,
  input: { hiveId: string; userId: string },
): Promise<EaThread> {
  const channelId = dashboardChannelId(input.hiveId);
  await closeActiveThread(sql, input.hiveId, channelId);
  return getOrCreateActiveThread(sql, input.hiveId, channelId);
}

export async function sendDashboardMessage(
  sql: Sql,
  input: {
    hiveId: string;
    hiveName?: string;
    userId: string;
    content: string;
    attachments?: EaAttachment[];
    signal?: AbortSignal;
  },
): Promise<DashboardSendResult> {
  const turn = await prepareDashboardTurn(sql, {
    hiveId: input.hiveId,
    hiveName: input.hiveName,
    content: input.content,
    attachments: input.attachments,
    signal: input.signal,
  });

  for await (const chunk of turn.stream) {
    void chunk;
    // Drain the stream for the JSON-compatible API path. The streaming
    // API path consumes the same adapter directly and sends each chunk.
  }

  const [latestAssistant] = await sql<EaMessage[]>`
    SELECT id, thread_id as "threadId", role, content,
           discord_message_id as "discordMessageId",
           source,
           voice_session_id as "voiceSessionId",
           status,
           error,
           created_at as "createdAt",
           updated_at as "updatedAt"
    FROM ea_messages
    WHERE id = ${turn.assistantMessage.id}
  `;
  const assistantMessage = latestAssistant;
  if (!assistantMessage) {
    throw new Error("Dashboard EA completed without persisting an assistant message");
  }

  return {
    thread: turn.thread,
    threadId: turn.thread.id,
    ownerMessage: turn.ownerMessage,
    assistantMessage,
  };
}

export const sendDashboardEaMessage = sendDashboardMessage;
