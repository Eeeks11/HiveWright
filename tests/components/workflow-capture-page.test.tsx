// @vitest-environment jsdom

/**
 * WorkflowCapturePage — orchestration fetch tests
 *
 * Verifies that the page's three network-touching flows each:
 *   - POST /api/capture-sessions with consent=true, hiveId, no raw media  (criterion 7a)
 *   - PATCH /api/capture-sessions/[id] status=stopped, no raw media       (criterion 7b)
 *   - DELETE /api/capture-sessions/[id] on cancel+confirm, no raw media   (criterion 7c)
 *
 * Also verifies consent gating: no POST fires before the dialog is confirmed.
 *
 * These tests complement the isolated component tests (capture-ui.test.tsx)
 * and the API unit tests (capture-sessions.test.ts) by verifying that the
 * WorkflowCapturePage orchestration layer wires up fetch correctly.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---- router mock (must be before any dynamic import) ----
const routerPushMock = vi.fn();
const workflowContextMock = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  searchParams: new URLSearchParams(),
  value: {
    selected: {
      id: "hive-test",
      name: "Test Hive",
      slug: "test-hive",
      type: "digital",
    } as { id: string; name: string; slug: string; type: string } | null,
    hives: [
      { id: "hive-test", name: "Test Hive", slug: "test-hive", type: "digital" },
      { id: "hive-target", name: "Target Hive", slug: "target-hive", type: "digital" },
    ],
    loading: false,
    hasProvider: true,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  useParams: () => workflowContextMock.params,
  useSearchParams: () => workflowContextMock.searchParams,
  usePathname: () => "/setup/workflow-capture",
}));

// ---- hive context mock ----
vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => workflowContextMock.value,
}));

// ---- next/link stub ----
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

function makeMockStream() {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  return { _track: track, getTracks: () => [track] };
}

class MockMediaRecorder {
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onerror: (() => void) | null = null;
  state = "recording";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_: unknown) {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(_timeslice?: number) {}
  stop() {
    this.state = "inactive";
  }
}

// Raw media field names that must never appear in any request body
const RAW_FIELDS = [
  "video",
  "audio",
  "frames",
  "screenshots",
  "blob",
  "rawMedia",
  "videoData",
  "audioData",
  "binaryData",
];

function assertNoRawMedia(body: unknown) {
  if (typeof body !== "object" || body === null) return;
  for (const field of RAW_FIELDS) {
    expect(
      (body as Record<string, unknown>)[field],
      `raw media field "${field}" must not appear in request body`,
    ).toBeUndefined();
  }
}

// Typed alias for fetch mock.calls entries
type FetchCall = [url: string, init?: RequestInit];

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  routerPushMock.mockReset();

  workflowContextMock.params = {};
  workflowContextMock.searchParams = new URLSearchParams();
  workflowContextMock.value.selected = {
    id: "hive-test",
    name: "Test Hive",
    slug: "test-hive",
    type: "digital",
  };
  workflowContextMock.value.hives = [
    { id: "hive-test", name: "Test Hive", slug: "test-hive", type: "digital" },
    { id: "hive-target", name: "Target Hive", slug: "target-hive", type: "digital" },
  ];
  workflowContextMock.value.hasProvider = true;

  // Set up browser capture APIs in jsdom
  Object.defineProperty(navigator, "mediaDevices", {
    writable: true,
    configurable: true,
    value: {
      getDisplayMedia: vi.fn().mockResolvedValue(makeMockStream()),
    },
  });

  Object.defineProperty(window, "MediaRecorder", {
    writable: true,
    configurable: true,
    value: MockMediaRecorder,
  });

  // Default: confirm dialogs are dismissed (cancel tests override this)
  vi.spyOn(window, "confirm").mockReturnValue(false);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: render the page (dynamic import ensures mocks are hoisted first)
// ---------------------------------------------------------------------------

async function renderWorkflowCapturePage() {
  const { default: WorkflowCapturePage } = await import(
    "../../src/app/(dashboard)/settings/workflow-capture/page"
  );
  return render(<WorkflowCapturePage />);
}

async function renderWorkflowCaptureReviewPage(captureId: string) {
  workflowContextMock.params = { captureId };
  const { default: WorkflowCaptureReviewPage } = await import(
    "../../src/app/(dashboard)/settings/workflow-capture/[captureId]/review/page"
  );
  return render(<WorkflowCaptureReviewPage />);
}

// ---------------------------------------------------------------------------
// Helper: drive through the full consent flow and wait for recording phase.
// ---------------------------------------------------------------------------

async function reachRecordingPhase(sessionId: string) {
  globalThis.fetch = vi.fn(
    async (url: string, opts?: RequestInit): Promise<Response> => {
      if (url === "/api/capture-sessions" && opts?.method === "POST") {
        return new Response(
          JSON.stringify({ data: { id: sessionId, status: "recording" } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { id: sessionId, status: "stopped" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  ) as typeof globalThis.fetch;

  await renderWorkflowCapturePage();

  fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /start recording/i }));

  // Wait until the recording pill appears (phase === "recording")
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /stop recording/i }),
    ).toBeTruthy(),
  );
}

// ---------------------------------------------------------------------------
// POST /api/capture-sessions — consent gating and payload
// ---------------------------------------------------------------------------

describe("WorkflowCapturePage — POST /api/capture-sessions", () => {
  it("does NOT call POST before consent dialog is confirmed", async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> =>
      new Response(JSON.stringify({ url }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCapturePage();

    // Open dialog — no network call yet
    fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT call POST when the consent dialog is cancelled", async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> =>
      new Response(JSON.stringify({ url }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCapturePage();

    fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs targetHiveId as hiveId after destination confirmation", async () => {
    workflowContextMock.searchParams = new URLSearchParams("targetHiveId=hive-target");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> => {
        if (url === "/api/capture-sessions" && opts?.method === "POST") {
          return new Response(
            JSON.stringify({ data: { id: "sess-target", status: "recording" } }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCapturePage();

    expect(screen.getByText(/Target mode: viewing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown as FetchCall[];
      const postCall = calls.find(([u, o]) => u === "/api/capture-sessions" && o?.method === "POST");
      expect(postCall).toBeTruthy();
      expect(JSON.parse(postCall![1]!.body as string).hiveId).toBe("hive-target");
    });
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("will update Target Hive, not your active hive Test Hive"));
  });

  it("fails closed for invalid targetHiveId without creating a capture session", async () => {
    workflowContextMock.searchParams = new URLSearchParams("targetHiveId=missing-hive");
    const fetchMock = vi.fn(async (url: string): Promise<Response> =>
      new Response(JSON.stringify({ url }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCapturePage();

    expect(screen.getByText(/Hive target/).textContent).toContain("missing-hive");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stop action — PATCH with status=stopped, then navigate to review
// ---------------------------------------------------------------------------

describe("WorkflowCapturePage — Stop → PATCH /api/capture-sessions/[id]", () => {
  it("PATCHes status=stopped, no raw media, then navigates to review shell", async () => {
    const sessionId = "sess-stop-001";
    await reachRecordingPhase(sessionId);

    const stopFetch = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> => {
        if (url === `/api/capture-sessions/${sessionId}` && opts?.method === "PATCH") {
          return new Response(
            JSON.stringify({ data: { id: sessionId, status: "stopped" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    );
    globalThis.fetch = stopFetch as typeof globalThis.fetch;

    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));

    await waitFor(() => {
      const calls = stopFetch.mock.calls as unknown as FetchCall[];
      const patchCall = calls.find(
        ([u, o]) =>
          u === `/api/capture-sessions/${sessionId}` && o?.method === "PATCH",
      );
      expect(patchCall, "PATCH to capture-sessions was not called on Stop").toBeTruthy();

      const body = JSON.parse(patchCall![1]!.body as string) as Record<string, unknown>;
      expect(body.status).toBe("stopped");
      assertNoRawMedia(body);
    });

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(
        `/setup/workflow-capture/${sessionId}/review`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Cancel action — DELETE /api/capture-sessions/[id], no raw media anywhere
// ---------------------------------------------------------------------------

describe("WorkflowCapturePage — Cancel → DELETE /api/capture-sessions/[id]", () => {
  it("DELETEs the session on confirm; no raw media in any request", async () => {
    const sessionId = "sess-cancel-001";

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await reachRecordingPhase(sessionId);

    const cancelFetch = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> => {
        if (url === `/api/capture-sessions/${sessionId}` && opts?.method === "DELETE") {
          return new Response(
            JSON.stringify({ data: { id: sessionId, purged: true } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    );
    globalThis.fetch = cancelFetch as typeof globalThis.fetch;

    fireEvent.click(
      screen.getByRole("button", {
        name: /cancel recording and discard all captured content/i,
      }),
    );

    await waitFor(() => {
      const calls = cancelFetch.mock.calls as unknown as FetchCall[];
      const deleteCall = calls.find(
        ([u, o]) =>
          u === `/api/capture-sessions/${sessionId}` && o?.method === "DELETE",
      );
      expect(deleteCall, "DELETE to capture-sessions was not called on Cancel").toBeTruthy();
    });

    // Confirm no raw media in any call body
    const allCalls = cancelFetch.mock.calls as unknown as FetchCall[];
    for (const [, opts] of allCalls) {
      if (opts?.body) {
        assertNoRawMedia(JSON.parse(opts.body as string) as Record<string, unknown>);
      }
    }
  });

  it("does NOT delete when the user dismisses the confirm dialog", async () => {
    const sessionId = "sess-cancel-dismiss";

    // window.confirm returns false (set in beforeEach)
    await reachRecordingPhase(sessionId);

    const cancelFetch = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ url, method: opts?.method }), { status: 200 }),
    );
    globalThis.fetch = cancelFetch as typeof globalThis.fetch;

    fireEvent.click(
      screen.getByRole("button", {
        name: /cancel recording and discard all captured content/i,
      }),
    );

    await new Promise((r) => setTimeout(r, 30));

    const calls = cancelFetch.mock.calls as unknown as FetchCall[];
    const deleteCall = calls.find(
      ([u, o]) =>
        u === `/api/capture-sessions/${sessionId}` && o?.method === "DELETE",
    );
    expect(deleteCall).toBeUndefined();
  });
});

function makeCaptureSession(sessionId: string, hiveId = "hive-target") {
  return {
    id: sessionId,
    hiveId,
    status: "stopped",
    startedAt: "2026-06-14T08:00:00.000Z",
    stoppedAt: "2026-06-14T08:01:00.000Z",
    captureScope: null,
    metadata: null,
    evidenceSummary: null,
    redactedSummary: null,
  };
}

function makeDraftPreview() {
  return {
    preview: {
      title: "Captured workflow",
      observedSteps: ["Open dashboard", "Review output"],
      inferredInputs: ["Owner decision"],
      decisionNotes: ["Keep inactive until review"],
      confidence: {
        level: "medium",
        score: 0.72,
        rationale: "Metadata-only capture contains enough workflow structure.",
      },
      sensitiveDataWarnings: [],
      redactionNotes: [],
      suggestedSkillContent: "---\nname: captured-workflow\n---\n# Captured workflow\n",
      source: {
        captureSessionId: "sess-review",
        fieldsUsed: ["captureScope", "metadata"],
        rawMediaAccepted: false,
      },
    },
    previewStatus: "generated",
    approvedDraftId: null,
    approvedDraftStatus: null,
    rawMediaAccepted: false,
  };
}

function mockReviewFetch(sessionId: string) {
  const fetchMock = vi.fn(
    async (url: string, opts?: RequestInit): Promise<Response> => {
      if (url === `/api/capture-sessions/${sessionId}` && !opts?.method) {
        return new Response(JSON.stringify({ data: makeCaptureSession(sessionId) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `/api/capture-sessions/${sessionId}/draft` && !opts?.method) {
        return new Response(JSON.stringify({ data: makeDraftPreview() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `/api/capture-sessions/${sessionId}/draft` && opts?.method === "POST") {
        return new Response(
          JSON.stringify({
            data: {
              draft: {
                id: "draft-1",
                slug: "captured-workflow",
                status: "inactive",
                qaReviewStatus: null,
                securityReviewStatus: null,
                internalSourceRef: sessionId,
                provenanceUrl: null,
                publishedAt: null,
              },
              created: true,
              duplicate: false,
              message: "Inactive draft created.",
              rawMediaAccepted: false,
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `/api/capture-sessions/${sessionId}/draft` && opts?.method === "DELETE") {
        return new Response(
          JSON.stringify({ data: { previewStatus: "rejected" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ url, method: opts?.method }), { status: 200 });
    },
  );
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Review shell — cross-hive draft write confirmation
// ---------------------------------------------------------------------------

describe("WorkflowCaptureReviewPage — target-mode draft writes", () => {
  it("does not approve a draft when cross-hive confirmation is cancelled", async () => {
    const sessionId = "sess-review-approve";
    workflowContextMock.searchParams = new URLSearchParams("targetHiveId=hive-target");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = mockReviewFetch(sessionId);

    await renderWorkflowCaptureReviewPage(sessionId);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /approve draft/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /approve draft/i }));

    await new Promise((r) => setTimeout(r, 30));

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Approve workflow capture draft will update Target Hive, not your active hive Test Hive"),
    );
    const calls = fetchMock.mock.calls as unknown as FetchCall[];
    expect(
      calls.some(([url, opts]) => url === `/api/capture-sessions/${sessionId}/draft` && opts?.method === "POST"),
    ).toBe(false);
  });

  it("does not reject a draft when cross-hive confirmation is cancelled", async () => {
    const sessionId = "sess-review-reject";
    workflowContextMock.searchParams = new URLSearchParams("targetHiveId=hive-target");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = mockReviewFetch(sessionId);

    await renderWorkflowCaptureReviewPage(sessionId);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /reject draft/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /reject draft/i }));

    await new Promise((r) => setTimeout(r, 30));

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Reject workflow capture draft will update Target Hive, not your active hive Test Hive"),
    );
    const calls = fetchMock.mock.calls as unknown as FetchCall[];
    expect(
      calls.some(([url, opts]) => url === `/api/capture-sessions/${sessionId}/draft` && opts?.method === "DELETE"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review shell — fail closed when URL target and loaded session hive disagree
// ---------------------------------------------------------------------------

describe("WorkflowCaptureReviewPage — target hive mismatch", () => {
  it("does not show draft/delete controls or fetch draft endpoints when targetHiveId mismatches the capture session hive", async () => {
    const sessionId = "sess-hive-a";
    workflowContextMock.searchParams = new URLSearchParams("targetHiveId=hive-target");
    const fetchMock = vi.fn(
      async (url: string): Promise<Response> => {
        if (url === `/api/capture-sessions/${sessionId}`) {
          return new Response(JSON.stringify({ data: makeCaptureSession(sessionId, "hive-test") }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCaptureReviewPage(sessionId);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Capture session belongs to Test Hive, but this page is targeting Target Hive",
      );
    });

    expect(screen.queryByRole("button", { name: /delete session/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /approve draft/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject draft/i })).toBeNull();

    const calls = fetchMock.mock.calls as unknown as FetchCall[];
    expect(calls.some(([url]) => url === `/api/capture-sessions/${sessionId}/draft`)).toBe(false);
    expect(calls.some(([, opts]) => opts?.method === "POST" || opts?.method === "DELETE")).toBe(false);
  });
});
