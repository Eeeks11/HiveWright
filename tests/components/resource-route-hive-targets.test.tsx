// @vitest-environment jsdom

import type { ReactNode } from "react";
import { fireEvent, waitFor } from "@testing-library/dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCard } from "../../src/components/agent-card";
import { GoalLiveActivity } from "../../src/components/goal-live-activity";
import { LiveActivityPanel } from "../../src/components/live-activity-panel";
import { SupervisorActivityPanel } from "../../src/components/supervisor-activity-panel";

type MessageHandler = ((event: MessageEvent) => void) | null;

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
});
