import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

// Point the voice adapter at the test DB instead of the prod default.
// Every other EA module takes `sql` as a parameter, but the voice-adapter
// owns its own DB handle (matching the pattern used by HTTP route
// handlers), so we rewire that handle to the shared test pool here.
vi.mock("@/app/api/_lib/db", () => ({ sql }));

// Stub out the real prompt builder — it runs ~6 queries against live
// hive state. We only need to assert voice-turn persistence, so a
// deterministic string keeps this isolated from the prompt surface.
vi.mock("@/ea/native/prompt", () => ({
  buildEaPrompt: async () => "STUB PROMPT",
}));

const mocks = vi.hoisted(() => ({
  getEaModelConfiguration: vi.fn(),
  resolveEaModelRoute: vi.fn(),
  recordEaModelRouteTelemetry: vi.fn(),
  runEaStream: vi.fn(),
}));

vi.mock("@/ea/native/model-selection", () => ({
  getEaModelConfiguration: mocks.getEaModelConfiguration,
  resolveEaModelRoute: mocks.resolveEaModelRoute,
  recordEaModelRouteTelemetry: mocks.recordEaModelRouteTelemetry,
}));

// Stub the streaming runner so we never spawn a `claude` subprocess.
// Yields three deltas that the adapter should concatenate verbatim.
vi.mock("@/ea/native/runner", () => ({
  runEaStream: mocks.runEaStream,
  runEa: async () => ({ success: true, text: "" }),
}));

mocks.runEaStream.mockImplementation(async function* () {
  yield "Hello";
  yield ", ";
  yield "Trent.";
});

import { eaVoiceClient } from "@/ea/native/voice-adapter";
import { VOICE_MODE_PROMPT_SUFFIX } from "@/connectors/voice/prompt";

const HIVE_ID = "66666666-6666-6666-6666-666666666666";
const SESSION_ID = "77777777-7777-7777-7777-777777777777";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'vb', 'Voice Biz', 'digital')
  `;
  await sql`
    INSERT INTO voice_sessions (id, hive_id)
    VALUES (${SESSION_ID}, ${HIVE_ID})
  `;
  vi.clearAllMocks();
  mocks.getEaModelConfiguration.mockResolvedValue({ primaryModel: null, fallbackModel: null });
  mocks.resolveEaModelRoute.mockResolvedValue({
    model: undefined,
    selected: "runtime_default",
    reason: "configuration_missing",
    primaryModel: null,
    fallbackModel: null,
  });
  mocks.runEaStream.mockImplementation(async function* () {
    yield "Hello";
    yield ", ";
    yield "Trent.";
  });
});

describe("eaVoiceClient.submit", () => {
  it("streams EA chunks and persists both turns to ea_messages", async () => {
    mocks.resolveEaModelRoute.mockResolvedValue({
      model: "openai-codex/gpt-5.6-sol",
      selected: "primary",
      reason: "fresh_healthy_probe",
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });

    const stream = await eaVoiceClient.submit("Hey, what's up?", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });

    const chunks: string[] = [];
    for await (const c of stream) chunks.push(c);

    expect(chunks).toEqual(["Hello", ", ", "Trent."]);
    expect(chunks.join("")).toBe("Hello, Trent.");
    expect(mocks.runEaStream).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        model: "openai-codex/gpt-5.6-sol",
      }),
    );
    expect(mocks.recordEaModelRouteTelemetry).toHaveBeenCalledWith(sql, {
      hiveId: HIVE_ID,
      transport: "voice",
      voiceSessionId: SESSION_ID,
      route: expect.objectContaining({ selected: "primary" }),
    });

    const rows = await sql<
      {
        role: string;
        content: string;
        source: string;
        voice_session_id: string | null;
      }[]
    >`
      SELECT m.role, m.content, m.source, m.voice_session_id
      FROM ea_messages m
      JOIN ea_threads t ON t.id = m.thread_id
      WHERE t.hive_id = ${HIVE_ID}
        AND t.channel_id = ${`voice:${SESSION_ID}`}
      ORDER BY m.created_at ASC
    `;

    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("owner");
    expect(rows[0].content).toBe("Hey, what's up?");
    expect(rows[0].source).toBe("voice");
    expect(rows[0].voice_session_id).toBe(SESSION_ID);

    expect(rows[1].role).toBe("assistant");
    expect(rows[1].content).toBe("Hello, Trent.");
    expect(rows[1].source).toBe("voice");
    expect(rows[1].voice_session_id).toBe(SESSION_ID);
  });

  it("selects and records the actual healthy fallback at 100% monthly spend", async () => {
    await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, status)
      VALUES (${HIVE_ID}, 'voice-ea', 'Voice EA', ${sql.json({ maxMonthlyLlmCents: 100 })}, 'active')
    `;
    await sql`UPDATE voice_sessions SET llm_cost_cents = 100 WHERE id = ${SESSION_ID}`;
    mocks.resolveEaModelRoute.mockResolvedValue({
      model: "openai-codex/gpt-5.5",
      selected: "fallback",
      reason: "budget_fallback",
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });

    const stream = await eaVoiceClient.submit("Keep going", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });
    for await (const chunk of stream) void chunk;

    expect(mocks.resolveEaModelRoute).toHaveBeenCalledWith(sql, HIVE_ID, {
      preferFallback: true,
    });
    expect(mocks.runEaStream).toHaveBeenCalledWith(expect.any(String), {
      model: "openai-codex/gpt-5.5",
    });
    expect(mocks.recordEaModelRouteTelemetry).toHaveBeenCalledWith(sql, {
      hiveId: HIVE_ID,
      transport: "voice",
      voiceSessionId: SESSION_ID,
      route: expect.objectContaining({
        selected: "fallback",
        model: "openai-codex/gpt-5.5",
      }),
    });
  });

  it("warns at 80% while retaining the healthy primary route", async () => {
    await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, status)
      VALUES (${HIVE_ID}, 'voice-ea', 'Voice EA', ${sql.json({ maxMonthlyLlmCents: 100 })}, 'active')
    `;
    await sql`UPDATE voice_sessions SET llm_cost_cents = 80 WHERE id = ${SESSION_ID}`;

    const stream = await eaVoiceClient.submit("Budget check", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });
    for await (const chunk of stream) void chunk;

    expect(mocks.resolveEaModelRoute).toHaveBeenCalledWith(sql, HIVE_ID, {
      preferFallback: false,
    });
    expect(mocks.runEaStream.mock.calls[0]?.[0]).toContain("## Budget warning");
    expect(mocks.runEaStream.mock.calls[0]?.[0]).toContain("80¢ of 100¢");
  });

  it("hangs up at 120% without starting another model call and records pause telemetry", async () => {
    await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, status)
      VALUES (${HIVE_ID}, 'voice-ea', 'Voice EA', ${sql.json({ maxMonthlyLlmCents: 100 })}, 'active')
    `;
    await sql`UPDATE voice_sessions SET llm_cost_cents = 120 WHERE id = ${SESSION_ID}`;
    mocks.getEaModelConfiguration.mockResolvedValue({
      primaryModel: "openai-codex/gpt-5.6-sol",
      fallbackModel: "openai-codex/gpt-5.5",
    });

    const stream = await eaVoiceClient.submit("One more thing", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks.join(" ")).toContain("monthly voice budget");
    expect(mocks.runEaStream).not.toHaveBeenCalled();
    expect(mocks.resolveEaModelRoute).not.toHaveBeenCalled();
    expect(mocks.recordEaModelRouteTelemetry).toHaveBeenCalledWith(sql, {
      hiveId: HIVE_ID,
      transport: "voice",
      voiceSessionId: SESSION_ID,
      route: expect.objectContaining({
        model: undefined,
        reason: "budget_pause_120_percent",
      }),
    });
  });

  it("reuses the same voice thread across multiple turns in a session", async () => {
    const first = await eaVoiceClient.submit("first", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });
    for await (const chunk of first) {
      void chunk;
    }

    const second = await eaVoiceClient.submit("second", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });
    for await (const chunk of second) {
      void chunk;
    }

    const [threadCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM ea_threads
      WHERE hive_id = ${HIVE_ID}
        AND channel_id = ${`voice:${SESSION_ID}`}
    `;
    expect(threadCount.count).toBe("1");

    const [msgCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM ea_messages m
      JOIN ea_threads t ON t.id = m.thread_id
      WHERE t.hive_id = ${HIVE_ID}
        AND t.channel_id = ${`voice:${SESSION_ID}`}
    `;
    // 2 owner + 2 assistant = 4
    expect(msgCount.count).toBe("4");
  });

  it("exports the voice-mode prompt suffix with the expected contract keywords", () => {
    // Guard against accidental deletion of the voice-mode rules the EA
    // is trained to follow — the plan text is load-bearing for tone.
    expect(VOICE_MODE_PROMPT_SUFFIX).toContain("Voice Mode");
    expect(VOICE_MODE_PROMPT_SUFFIX).toContain("Three response modes");
    expect(VOICE_MODE_PROMPT_SUFFIX).toContain("AirPods");
  });
});
