import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

vi.mock("@/app/api/_lib/db", () => ({ sql }));

const mocks = vi.hoisted(() => ({
  state: { streamReturned: false },
  buildEaPrompt: vi.fn(async () => "FULL EA PROMPT"),
  runEaStream: vi.fn(),
  resolveEaModelRoute: vi.fn(),
  recordEaModelRouteTelemetry: vi.fn(),
  scheduleImplicitQualityExtraction: vi.fn(),
}));

mocks.runEaStream.mockImplementation(
  async function* (prompt: string, options?: { signal?: AbortSignal }) {
    void prompt;
    void options;
    try {
      yield "Hello";
      yield ", dashboard.";
    } finally {
      mocks.state.streamReturned = true;
    }
  },
);

vi.mock("@/ea/native/prompt", () => ({
  buildEaPrompt: mocks.buildEaPrompt,
}));

vi.mock("@/ea/native/model-selection", () => ({
  resolveEaModelRoute: mocks.resolveEaModelRoute,
  recordEaModelRouteTelemetry: mocks.recordEaModelRouteTelemetry,
}));

vi.mock("@/ea/native/runner", () => ({
  runEaStream: mocks.runEaStream,
  runEa: vi.fn(),
}));

vi.mock("@/quality/ea-post-turn", () => ({
  scheduleImplicitQualityExtraction: mocks.scheduleImplicitQualityExtraction,
}));

import { dashboardEaClient } from "@/ea/native/dashboard-chat";
import type { EaMessage } from "@/ea/native/thread-store";

const HIVE_ID = "99999999-9999-4999-8999-999999999999";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'dashboard-chat-native', 'Dashboard Native Hive', 'digital')
  `;
  vi.clearAllMocks();
  mocks.state.streamReturned = false;
  mocks.resolveEaModelRoute.mockResolvedValue({
    model: undefined,
    selected: "runtime_default",
    reason: "configuration_missing",
    primaryModel: null,
    fallbackModel: null,
  });
});

describe("dashboardEaClient.submit", () => {
  it("builds the full EA prompt, uses the dashboard hive thread, and persists both turns", async () => {
    mocks.resolveEaModelRoute.mockResolvedValue({
      model: "openai-codex/gpt-5.6-sol",
      selected: "primary",
      reason: "fresh_healthy_probe",
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });

    const stream = await dashboardEaClient.submit("What active goals do I have?", {
      hiveId: HIVE_ID,
      hiveName: "Dashboard Native Hive",
    });

    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual(["Hello", ", dashboard."]);
    expect(mocks.buildEaPrompt).toHaveBeenCalledTimes(1);
    const buildPromptCalls = mocks.buildEaPrompt.mock.calls as unknown as Array<
      [
        unknown,
        {
          hiveId: string;
          hiveName: string;
          currentOwnerMessage: string;
          history: EaMessage[];
        },
      ]
    >;
    const promptInput = buildPromptCalls[0]?.[1];
    expect(promptInput).toMatchObject({
      hiveId: HIVE_ID,
      hiveName: "Dashboard Native Hive",
      currentOwnerMessage: "What active goals do I have?",
    });
    expect(promptInput?.history.at(-1)).toMatchObject({
      role: "owner",
      content: "What active goals do I have?",
      source: "dashboard",
    });
    const firstRunCalls = mocks.runEaStream.mock.calls as Array<
      [string, { signal?: AbortSignal; attachmentPaths?: string[] } | undefined]
    >;
    const firstRunOptions = firstRunCalls[0]?.[1];
    expect(mocks.runEaStream).toHaveBeenCalledWith("FULL EA PROMPT", {
      signal: firstRunOptions?.signal,
      attachmentPaths: [],
      model: "openai-codex/gpt-5.6-sol",
    });
    expect(mocks.recordEaModelRouteTelemetry).toHaveBeenCalledWith(sql, {
      hiveId: HIVE_ID,
      transport: "dashboard",
      route: expect.objectContaining({ selected: "primary" }),
    });
    expect(firstRunOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(firstRunOptions?.signal?.aborted).toBe(false);

    const rows = await sql<
      {
        channel_id: string;
        role: string;
        content: string;
        source: string;
        status: string;
        error: string | null;
      }[]
    >`
      SELECT t.channel_id, m.role, m.content, m.source, m.status, m.error
      FROM ea_messages m
      JOIN ea_threads t ON t.id = m.thread_id
      WHERE t.hive_id = ${HIVE_ID}
      ORDER BY m.created_at ASC
    `;

    expect(rows).toEqual([
      {
        channel_id: `dashboard:${HIVE_ID}`,
        role: "owner",
        content: "What active goals do I have?",
        source: "dashboard",
        status: "sent",
        error: null,
      },
      {
        channel_id: `dashboard:${HIVE_ID}`,
        role: "assistant",
        content: "Hello, dashboard.",
        source: "dashboard",
        status: "sent",
        error: null,
      },
    ]);
    expect(mocks.scheduleImplicitQualityExtraction).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        hiveId: HIVE_ID,
        ownerMessage: "What active goals do I have?",
      }),
    );
  });

  it("passes dashboard attachment paths through to runEaStream", async () => {
    const stream = await dashboardEaClient.submit("Review this brief", {
      hiveId: HIVE_ID,
      hiveName: "Dashboard Native Hive",
      attachments: [
        {
          filename: "brief.pdf",
          absolutePath: "/tmp/hivewright-ea-attachments/dashboard-1/brief.pdf",
          contentType: "application/pdf",
          size: 2048,
        },
      ],
    });

    for await (const chunk of stream) void chunk;

    const runCalls = mocks.runEaStream.mock.calls as Array<
      [string, { signal?: AbortSignal; attachmentPaths?: string[] } | undefined]
    >;
    expect(runCalls[0]?.[0]).toContain("@/tmp/hivewright-ea-attachments/dashboard-1/brief.pdf");
    expect(runCalls[0]?.[1]?.attachmentPaths).toEqual([
      "/tmp/hivewright-ea-attachments/dashboard-1/brief.pdf",
    ]);
  });

  it("aborts the runEaStream signal when the dashboard stream consumer breaks early", async () => {
    const controller = new AbortController();
    const stream = await dashboardEaClient.submit("stop early", {
      hiveId: HIVE_ID,
      signal: controller.signal,
    });

    for await (const chunk of stream) {
      expect(chunk).toBe("Hello");
      break;
    }

    const runCalls = mocks.runEaStream.mock.calls as Array<
      [string, { signal?: AbortSignal; attachmentPaths?: string[] } | undefined]
    >;
    const runOptions = runCalls[0]?.[1];
    expect(runOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(runOptions?.signal).not.toBe(controller.signal);
    expect(runOptions?.signal?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(mocks.state.streamReturned).toBe(true);

    const [assistant] = await sql<{ content: string; status: string; error: string | null }[]>`
      SELECT content, status, error
      FROM ea_messages
      WHERE role = 'assistant'
    `;
    expect(assistant).toEqual({
      content: "Hello",
      status: "failed",
      error: "EA response was interrupted before completion.",
    });
  });

  it("persists the assistant as streaming before the first chunk is consumed", async () => {
    const stream = await dashboardEaClient.submit("show pending state", {
      hiveId: HIVE_ID,
    });

    const [assistant] = await sql<{ id: string; content: string; status: string; error: string | null }[]>`
      SELECT id, content, status, error
      FROM ea_messages
      WHERE role = 'assistant'
    `;
    expect(assistant).toMatchObject({ content: "", status: "streaming", error: null });

    for await (const chunk of stream) void chunk;
  });

  it("marks an aborted run failed with a safe error and a fresh updated timestamp", async () => {
    const controller = new AbortController();
    mocks.runEaStream.mockImplementationOnce(async function* (_prompt, options) {
      controller.abort();
      const error = new Error("request aborted with secret provider detail");
      error.name = "AbortError";
      expect(options?.signal?.aborted).toBe(true);
      throw error;
    });
    const stream = await dashboardEaClient.submit("abort this", {
      hiveId: HIVE_ID,
      signal: controller.signal,
    });
    const [before] = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM ea_messages WHERE role = 'assistant'
    `;
    await sql`SELECT pg_sleep(0.01)`;

    await expect(async () => {
      for await (const chunk of stream) void chunk;
    }).rejects.toThrow();

    const [after] = await sql<{ content: string; status: string; error: string | null; updated_at: Date }[]>`
      SELECT content, status, error, updated_at FROM ea_messages WHERE role = 'assistant'
    `;
    expect(after).toMatchObject({
      content: "",
      status: "failed",
      error: "EA response was interrupted before completion.",
    });
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.error).not.toContain("secret provider detail");
  });

  it("marks a thrown runner error failed without persisting raw error detail", async () => {
    mocks.runEaStream.mockImplementationOnce(async function* () {
      throw new Error("provider token sk-secret must never persist");
    });
    const stream = await dashboardEaClient.submit("runner failure", { hiveId: HIVE_ID });

    await expect(async () => {
      for await (const chunk of stream) void chunk;
    }).rejects.toThrow();

    const [assistant] = await sql<{ content: string; status: string; error: string | null }[]>`
      SELECT content, status, error FROM ea_messages WHERE role = 'assistant'
    `;
    expect(assistant).toEqual({
      content: "",
      status: "failed",
      error: "EA response failed before completion.",
    });
  });

  it("marks whitespace-only successful output failed", async () => {
    mocks.runEaStream.mockImplementationOnce(async function* () {
      yield "  \n";
    });
    const stream = await dashboardEaClient.submit("empty response", { hiveId: HIVE_ID });

    await expect(async () => {
      for await (const chunk of stream) void chunk;
    }).rejects.toThrow("EA returned an empty response");

    const [assistant] = await sql<{ content: string; status: string; error: string | null }[]>`
      SELECT content, status, error FROM ea_messages WHERE role = 'assistant'
    `;
    expect(assistant).toEqual({
      content: "  \n",
      status: "failed",
      error: "EA returned no response.",
    });
  });

  it("retains partial output but marks it terminally failed", async () => {
    mocks.runEaStream.mockImplementationOnce(async function* () {
      yield "Partial owner-visible answer";
      throw new Error("runner exited 1");
    });
    const stream = await dashboardEaClient.submit("partial failure", { hiveId: HIVE_ID });

    await expect(async () => {
      for await (const chunk of stream) void chunk;
    }).rejects.toThrow();

    const [assistant] = await sql<{ content: string; status: string; error: string | null }[]>`
      SELECT content, status, error FROM ea_messages WHERE role = 'assistant'
    `;
    expect(assistant).toEqual({
      content: "Partial owner-visible answer",
      status: "failed",
      error: "EA response failed before completion.",
    });

    const retryStream = await dashboardEaClient.submit("retry after partial", { hiveId: HIVE_ID });
    for await (const chunk of retryStream) void chunk;
    const promptCalls = mocks.buildEaPrompt.mock.calls as unknown as Array<
      [unknown, { history: EaMessage[] }]
    >;
    expect(promptCalls.at(-1)?.[1].history).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        content: "Partial owner-visible answer",
        status: "failed",
      }),
    ]));
  });

  it("does not let a stale completion overwrite a failed turn after a retry starts", async () => {
    const stream = await dashboardEaClient.submit("first attempt", { hiveId: HIVE_ID });
    const [first] = await sql<{ id: string; thread_id: string }[]>`
      SELECT id, thread_id FROM ea_messages WHERE role = 'assistant'
    `;
    await sql`
      UPDATE ea_messages
      SET status = 'failed', error = 'EA response was interrupted before completion.', updated_at = NOW()
      WHERE id = ${first.id}
    `;
    const [retry] = await sql<{ id: string }[]>`
      INSERT INTO ea_messages (thread_id, role, content, source, status)
      VALUES (${first.thread_id}, 'assistant', '', 'dashboard', 'streaming')
      RETURNING id
    `;

    for await (const chunk of stream) void chunk;

    const rows = await sql<{ id: string; content: string; status: string }[]>`
      SELECT id, content, status
      FROM ea_messages
      WHERE role = 'assistant'
      ORDER BY created_at ASC, id ASC
    `;
    expect(rows).toEqual(expect.arrayContaining([
      { id: first.id, content: "", status: "failed" },
      { id: retry.id, content: "", status: "streaming" },
    ]));
  });
});
