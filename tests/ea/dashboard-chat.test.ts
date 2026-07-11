import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
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

import {
  DashboardEaTurnInProgressError,
  dashboardEaClient,
  getDashboardChat,
  sendDashboardMessage,
} from "@/ea/native/dashboard-chat";
import type { EaMessage } from "@/ea/native/thread-store";

const HIVE_ID = "99999999-9999-4999-8999-999999999999";
const COLLIDING_HIVE_ID_ONE = "9fec36b0-c867-4804-815e-81970934980c";
const COLLIDING_HIVE_ID_TWO = "38a4cfb7-d7c2-4d79-947b-01137897c369";

type QuerySql = Sql | TransactionSql;

function interceptQueries(
  base: QuerySql,
  beforeQuery: (query: string) => Promise<void>,
  onTransaction?: (tx: TransactionSql) => Promise<void>,
): Sql {
  return new Proxy(base as Sql, {
    apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
      const query = args[0].join("?");
      return beforeQuery(query).then(() => Reflect.apply(target, thisArg, args));
    },
    get(target, property, receiver) {
      if (property === "begin") {
        return (callback: (tx: TransactionSql) => Promise<unknown>) =>
          target.begin(async (tx) => {
            await onTransaction?.(tx);
            return callback(
              interceptQueries(tx, beforeQuery) as unknown as TransactionSql,
            );
          });
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
      ORDER BY m.created_at ASC,
        CASE m.role
          WHEN 'system' THEN 0
          WHEN 'owner' THEN 1
          WHEN 'assistant' THEN 2
          ELSE 3
        END ASC,
        m.id ASC
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

  it("returns dashboard history in owner-before-assistant order when created_at ties", async () => {
    const stream = await dashboardEaClient.submit("same timestamp turn", {
      hiveId: HIVE_ID,
      hiveName: "Dashboard Native Hive",
    });
    for await (const chunk of stream) void chunk;

    const tiedCreatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    await sql`
      UPDATE ea_messages
      SET created_at = ${tiedCreatedAt}
      WHERE source = 'dashboard'
    `;

    const chat = await getDashboardChat(sql, {
      hiveId: HIVE_ID,
      userId: "owner-one",
    });

    expect(chat.messages.map((message) => message.role)).toEqual(["owner", "assistant"]);
    expect(chat.messages.map((message) => message.content)).toEqual([
      "same timestamp turn",
      "Hello, dashboard.",
    ]);
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

  it("allows exactly one of two coordinated connections to claim and start a turn", async () => {
    const firstReachedActiveTurnCheck = deferred();
    const releaseFirstActiveTurnCheck = deferred();
    const backendPids: number[] = [];
    let delayedFirstCheck = false;
    const recordBackendPid = async (tx: TransactionSql) => {
      const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      backendPids.push(row.pid);
    };

    const firstSql = interceptQueries(sql, async (query) => {
      if (!delayedFirstCheck && query.includes("FROM ea_messages") && query.includes("status = 'streaming'")) {
        delayedFirstCheck = true;
        firstReachedActiveTurnCheck.resolve();
        await releaseFirstActiveTurnCheck.promise;
      }
    }, recordBackendPid);
    const secondSql = interceptQueries(sql, async () => {}, recordBackendPid);
    let firstRequest: Promise<unknown> | undefined;

    try {
      firstRequest = sendDashboardMessage(firstSql, {
        hiveId: HIVE_ID,
        userId: "owner-one",
        content: "first concurrent request",
      });
      await firstReachedActiveTurnCheck.promise;

      const secondRequest = sendDashboardMessage(secondSql, {
        hiveId: HIVE_ID,
        userId: "owner-two",
        content: "second concurrent request",
      });
      const secondOutcome = await secondRequest.then(
        () => null,
        (error: unknown) => error,
      );

      releaseFirstActiveTurnCheck.resolve();
      await firstRequest;

      expect(secondOutcome).toBeInstanceOf(DashboardEaTurnInProgressError);
      expect(new Set(backendPids).size).toBe(2);
      expect(mocks.runEaStream).toHaveBeenCalledTimes(1);
      const messages = await sql<{ role: string; content: string }[]>`
        SELECT role, content
        FROM ea_messages
        ORDER BY created_at ASC,
        CASE role
          WHEN 'system' THEN 0
          WHEN 'owner' THEN 1
          WHEN 'assistant' THEN 2
          ELSE 3
        END ASC,
        id ASC
      `;
      expect(messages).toEqual([
        { role: "owner", content: "first concurrent request" },
        { role: "assistant", content: "Hello, dashboard." },
      ]);
    } finally {
      releaseFirstActiveTurnCheck.resolve();
      if (firstRequest) await Promise.allSettled([firstRequest]);
    }
  });

  it("does not falsely conflict across hives whose legacy 32-bit hashes collide", async () => {
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES
        (${COLLIDING_HIVE_ID_ONE}, 'dashboard-hash-collision-one', 'Collision Hive One', 'digital'),
        (${COLLIDING_HIVE_ID_TWO}, 'dashboard-hash-collision-two', 'Collision Hive Two', 'digital')
    `;
    const firstLockKey = `dashboard-ea-turn:${COLLIDING_HIVE_ID_ONE}:dashboard:${COLLIDING_HIVE_ID_ONE}`;
    const secondLockKey = `dashboard-ea-turn:${COLLIDING_HIVE_ID_TWO}:dashboard:${COLLIDING_HIVE_ID_TWO}`;
    const [hashes] = await sql<{
      legacyFirst: number;
      legacySecond: number;
      extendedKeysDiffer: boolean;
    }[]>`
      SELECT
        hashtext(${firstLockKey}) AS "legacyFirst",
        hashtext(${secondLockKey}) AS "legacySecond",
        hashtextextended(${firstLockKey}, 0) <> hashtextextended(${secondLockKey}, 0)
          AS "extendedKeysDiffer"
    `;
    expect(hashes).toEqual({
      legacyFirst: 1789377752,
      legacySecond: 1789377752,
      extendedKeysDiffer: true,
    });

    const firstLocksAcquired = deferred();
    const releaseFirstLocks = deferred();
    const heldLocks = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${firstLockKey}))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${firstLockKey}, 0))`;
      firstLocksAcquired.resolve();
      await releaseFirstLocks.promise;
    });

    try {
      await firstLocksAcquired.promise;

      await sendDashboardMessage(sql, {
        hiveId: COLLIDING_HIVE_ID_TWO,
        userId: "owner-two",
        content: "second colliding-hash hive request",
      });

      const messages = await sql<{ roles: string[] }[]>`
        SELECT array_agg(message.role ORDER BY message.role) AS roles
        FROM ea_messages AS message
        JOIN ea_threads AS thread ON thread.id = message.thread_id
        WHERE thread.hive_id = ${COLLIDING_HIVE_ID_TWO}
      `;
      expect(messages).toEqual([{ roles: ["assistant", "owner"] }]);
      expect(mocks.runEaStream).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirstLocks.resolve();
      await heldLocks;
    }
  });

  it("rolls back a partial claim and permits one clean retry", async () => {
    await sql.unsafe(`
      CREATE FUNCTION fail_dashboard_assistant_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.role = 'assistant' AND NEW.source = 'dashboard' THEN
          RAISE EXCEPTION 'forced assistant insert failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER fail_dashboard_assistant_insert
      BEFORE INSERT ON ea_messages
      FOR EACH ROW EXECUTE FUNCTION fail_dashboard_assistant_insert();
    `);

    let messageCountAfterFailure = -1;
    try {
      await expect(
        dashboardEaClient.submit("claim that must roll back", { hiveId: HIVE_ID }),
      ).rejects.toThrow("forced assistant insert failure");

      const [row] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM ea_messages
      `;
      messageCountAfterFailure = row.count;
    } finally {
      await sql.unsafe(`
        DROP TRIGGER fail_dashboard_assistant_insert ON ea_messages;
        DROP FUNCTION fail_dashboard_assistant_insert();
      `);
    }

    expect(messageCountAfterFailure).toBe(0);

    const retry = await dashboardEaClient.submit("clean retry", { hiveId: HIVE_ID });
    for await (const chunk of retry) void chunk;

    const rows = await sql<{ role: string; content: string; status: string }[]>`
      SELECT role, content, status
      FROM ea_messages
      ORDER BY created_at ASC,
        CASE role
          WHEN 'system' THEN 0
          WHEN 'owner' THEN 1
          WHEN 'assistant' THEN 2
          ELSE 3
        END ASC,
        id ASC
    `;
    expect(rows).toEqual([
      { role: "owner", content: "clean retry", status: "sent" },
      { role: "assistant", content: "Hello, dashboard.", status: "sent" },
    ]);
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
      ORDER BY created_at ASC,
        CASE role
          WHEN 'system' THEN 0
          WHEN 'owner' THEN 1
          WHEN 'assistant' THEN 2
          ELSE 3
        END ASC,
        id ASC
    `;
    expect(rows).toEqual(expect.arrayContaining([
      { id: first.id, content: "", status: "failed" },
      { id: retry.id, content: "", status: "streaming" },
    ]));
  });
});
