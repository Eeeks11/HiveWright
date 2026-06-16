// @vitest-environment jsdom

import type { ReactNode } from "react";
import { fireEvent, waitFor } from "@testing-library/dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCard } from "../../src/components/agent-card";
import { GoalLiveActivity } from "../../src/components/goal-live-activity";
import { HiveConnectorsPanel } from "../../src/components/hives/hive-connectors-panel";
import { LiveActivityPanel } from "../../src/components/live-activity-panel";
import { SupervisorActivityPanel } from "../../src/components/supervisor-activity-panel";

type MessageHandler = ((event: MessageEvent) => void) | null;

const navigationMock = vi.hoisted(() => ({
  params: { captureId: "session-abc" },
  routerPush: vi.fn(),
  searchParams: new URLSearchParams(),
}));

const hiveContextMock = vi.hoisted(() => ({
  selected: {
    id: "hive-111",
    name: "Test Hive",
    slug: "test-hive",
    type: "digital",
  },
  hives: [
    {
      id: "hive-111",
      name: "Test Hive",
      slug: "test-hive",
      type: "digital",
    },
  ],
  loading: false,
  hasProvider: true,
}));

vi.mock("next/navigation", () => ({
  useParams: () => navigationMock.params,
  usePathname: () => "/setup/workflow-capture/session-abc/review",
  useRouter: () => ({ push: navigationMock.routerPush }),
  useSearchParams: () => navigationMock.searchParams,
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => hiveContextMock,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onmessage: MessageHandler = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close() {}
}

let container: HTMLDivElement;
let root: Root;

async function renderNode(node: ReactNode) {
  root.render(node);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("resource-id client callers carry hive targets", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/goals/goal-1/supervisor?hiveId=hive-1" && !init) {
        return new Response(JSON.stringify({
          data: {
            threadId: null,
            workspacePath: null,
            rolloutPath: null,
            lastActivityAt: null,
            active: false,
            events: [],
            goalStatus: "pending",
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/tasks/task-1/cancel" && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { cancelled: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("alert", vi.fn());
    navigationMock.params = { captureId: "session-abc" };
    navigationMock.routerPush.mockReset();
    navigationMock.searchParams = new URLSearchParams();
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens the task detail live stream with an explicit hiveId query", async () => {
    await renderNode(<LiveActivityPanel hiveId="hive-1" taskId="task-1" taskTitle="Build X" />);

    await waitFor(() => {
      expect(MockEventSource.instances[0]?.url).toBe("/api/tasks/task-1/stream?hiveId=hive-1");
    });
  });

  it("opens the active-task card stream with hiveId and posts hiveId on cancel", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    await renderNode(
      <AgentCard
        hiveId="hive-1"
        taskId="task-1"
        assignedTo="dev-agent"
        title="Build X"
      />,
    );

    await waitFor(() => {
      expect(MockEventSource.instances[0]?.url).toBe("/api/tasks/task-1/stream?hiveId=hive-1");
    });

    const cancelButton = container.querySelector('button[aria-label="Cancel task: Build X"]');
    expect(cancelButton).toBeTruthy();
    fireEvent.click(cancelButton as Element);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/tasks/task-1/cancel",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ hiveId: "hive-1" }),
        }),
      );
    });
  });

  it("opens the goal live stream with an explicit hiveId query", async () => {
    await renderNode(<GoalLiveActivity hiveId="hive-1" goalId="goal-1" />);

    await waitFor(() => {
      expect(MockEventSource.instances[0]?.url).toBe("/api/goals/goal-1/stream?hiveId=hive-1");
    });
  });

  it("polls supervisor activity with an explicit hiveId query", async () => {
    await renderNode(<SupervisorActivityPanel hiveId="hive-1" goalId="goal-1" />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/goals/goal-1/supervisor?hiveId=hive-1");
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No supervisor session yet");
    });
  });

  it("passes hiveId to connector install action history, test, and status update calls", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/connectors?hiveId=hive-1") {
        return jsonResponse({ data: [connectorFixture()] });
      }
      if (url === "/api/connector-installs?hiveId=hive-1") {
        return jsonResponse({ data: [connectorInstallFixture()] });
      }
      if (url === "/api/connector-installs/install-1/actions?hiveId=hive-1") {
        return jsonResponse({ data: [] });
      }
      if (url === "/api/connector-installs/install-1/test" && init?.method === "POST") {
        return jsonResponse({ data: { success: true, durationMs: 4 } });
      }
      if (url === "/api/connector-installs/install-1" && init?.method === "PATCH") {
        return jsonResponse({ data: { ...connectorInstallFixture(), status: "disabled" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderNode(<HiveConnectorsPanel hiveId="hive-1" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/connector-installs/install-1/actions?hiveId=hive-1");
    });

    const testButton = await waitFor(() => {
      const button = container.querySelector('button[aria-label="Test Discord"]');
      expect(button).toBeTruthy();
      return button as Element;
    });
    fireEvent.click(testButton);

    await waitFor(() => {
      const testCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/connector-installs/install-1/test" && init?.method === "POST",
      );
      expect(testCall).toBeTruthy();
      expect(JSON.parse(testCall![1]!.body as string)).toEqual({ hiveId: "hive-1" });
    });

    const disableButton = await waitFor(() => {
      const button = container.querySelector('button[aria-label="Disable Discord"]');
      expect(button).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button as Element;
    });
    fireEvent.click(disableButton);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/connector-installs/install-1" && init?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(patchCall![1]!.body as string)).toMatchObject({
        hiveId: "hive-1",
        status: "disabled",
      });
    });
  });

  it("passes hiveId to capture review session, draft, and delete resource calls", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/capture-sessions/session-abc?hiveId=hive-111" && !init?.method) {
        return jsonResponse({ data: captureSessionFixture() });
      }
      if (url === "/api/capture-sessions/session-abc/draft?hiveId=hive-111" && !init?.method) {
        return jsonResponse({ data: captureDraftPreviewFixture() });
      }
      if (url === "/api/capture-sessions/session-abc/draft?hiveId=hive-111" && init?.method === "POST") {
        return jsonResponse({ data: captureDraftCreateFixture() }, 201);
      }
      if (url === "/api/capture-sessions/session-abc/draft?hiveId=hive-111" && init?.method === "DELETE") {
        return jsonResponse({ data: { previewStatus: "rejected", rejected: true, rawMediaAccepted: false } });
      }
      if (url === "/api/capture-sessions/session-abc?hiveId=hive-111" && init?.method === "DELETE") {
        return jsonResponse({ data: { deleted: true } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { default: CaptureReviewPage } = await import(
      "../../src/app/(dashboard)/settings/workflow-capture/[captureId]/review/page"
    );

    await renderNode(<CaptureReviewPage />);

    await waitFor(() => {
      expect(container.textContent).toContain("session-abc");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/capture-sessions/session-abc?hiveId=hive-111");
    expect(fetchMock).toHaveBeenCalledWith("/api/capture-sessions/session-abc/draft?hiveId=hive-111");

    fireEvent.click(buttonWithText("Approve Draft"));
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/capture-sessions/session-abc/draft?hiveId=hive-111" && init?.method === "POST",
      );
      expect(postCall).toBeTruthy();
    });

    fireEvent.click(buttonWithText("Delete session"));
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/capture-sessions/session-abc?hiveId=hive-111" && init?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it("passes hiveId when rejecting a capture draft preview", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/capture-sessions/session-abc?hiveId=hive-111" && !init?.method) {
        return jsonResponse({ data: captureSessionFixture() });
      }
      if (url === "/api/capture-sessions/session-abc/draft?hiveId=hive-111" && !init?.method) {
        return jsonResponse({ data: captureDraftPreviewFixture() });
      }
      if (url === "/api/capture-sessions/session-abc/draft?hiveId=hive-111" && init?.method === "DELETE") {
        return jsonResponse({ data: { previewStatus: "rejected", rejected: true, rawMediaAccepted: false } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { default: CaptureReviewPage } = await import(
      "../../src/app/(dashboard)/settings/workflow-capture/[captureId]/review/page"
    );

    await renderNode(<CaptureReviewPage />);

    await waitFor(() => {
      expect(container.textContent).toContain("session-abc");
    });
    fireEvent.click(buttonWithText("Reject Draft"));

    await waitFor(() => {
      const rejectCall = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/capture-sessions/session-abc/draft?hiveId=hive-111" && init?.method === "DELETE",
      );
      expect(rejectCall).toBeTruthy();
    });
  });
});

function buttonWithText(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  return button as Element;
}

function connectorFixture() {
  return {
    slug: "discord-webhook",
    name: "Discord webhook",
    category: "messaging",
    description: "Post messages to Discord",
    icon: null,
    authType: "webhook",
    setupFields: [],
    scopes: [],
    capabilities: ["health"],
    operations: [],
  };
}

function connectorInstallFixture() {
  return {
    id: "install-1",
    hiveId: "hive-1",
    connectorSlug: "discord-webhook",
    displayName: "Discord",
    config: {},
    credentialConfigured: true,
    status: "active",
    lastTestedAt: null,
    lastSyncedAt: null,
    lastError: null,
    lastSyncError: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    successes7d: 0,
    errors7d: 0,
    grantedScopes: [],
    capabilities: ["health"],
  };
}

function captureSessionFixture() {
  return {
    id: "session-abc",
    hiveId: "hive-111",
    status: "stopped",
    startedAt: "2026-06-01T00:00:00.000Z",
    stoppedAt: "2026-06-01T00:01:00.000Z",
    captureScope: { type: "browser_tab" },
    metadata: { title: "Review workflow" },
    evidenceSummary: null,
    redactedSummary: null,
  };
}

function captureDraftPreviewFixture() {
  return {
    preview: {
      title: "Review workflow",
      observedSteps: ["Open dashboard"],
      inferredInputs: ["Owner choice"],
      decisionNotes: ["Keep inactive"],
      confidence: {
        level: "medium",
        score: 0.7,
        rationale: "Metadata is sufficient for review.",
      },
      sensitiveDataWarnings: [],
      redactionNotes: [],
      suggestedSkillContent: "# Review workflow\n",
      source: {
        captureSessionId: "session-abc",
        fieldsUsed: ["metadata"],
        rawMediaAccepted: false,
      },
    },
    previewStatus: "generated",
    approvedDraftId: null,
    approvedDraftStatus: null,
    rawMediaAccepted: false,
  };
}

function captureDraftCreateFixture() {
  return {
    draft: {
      id: "draft-1",
      slug: "review-workflow",
      status: "pending",
      qaReviewStatus: "pending",
      securityReviewStatus: "not_required",
      internalSourceRef: "capture-session:session-abc",
      provenanceUrl: "/setup/workflow-capture/session-abc/review",
      publishedAt: null,
    },
    created: true,
    duplicate: false,
    message: "Inactive pending draft created from capture session metadata.",
    rawMediaAccepted: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
