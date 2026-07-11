// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/dom";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useVoiceCallDirect } from "@/hooks/useVoiceCallDirect";

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener() {}

  close() {
    this.closed = true;
  }
}

type WebSocketListener = (event?: MessageEvent | Event) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  binaryType = "blob";
  sent: Array<ArrayBuffer | string> = [];
  private listeners = new Map<string, WebSocketListener[]>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    });
  }

  addEventListener(type: string, listener: WebSocketListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: ArrayBuffer | string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  emit(type: string, event?: MessageEvent | Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class MockAudioContext {
  audioWorklet = {
    addModule: vi.fn(async () => undefined),
  };
  currentTime = 0;
  destination = {};

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
    };
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: vi.fn((node: unknown) => node),
    };
  }

  close() {
    return Promise.resolve();
  }
}

class MockAudioWorkletNode {
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
  };

  connect(node: unknown) {
    return node;
  }
}

function VoiceHookHarness({ hiveId }: { hiveId: string }) {
  const { startCall } = useVoiceCallDirect(hiveId);

  return (
    <button type="button" onClick={() => void startCall()}>
      Start call
    </button>
  );
}

describe("useVoiceCallDirect", () => {
  const mediaStream = {
    getTracks: () => [{ stop: vi.fn() }],
  };
  let container: HTMLDivElement;
  let root: Root;

  async function renderNode(node: ReactNode) {
    root.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    MockEventSource.instances = [];
    MockWebSocket.instances = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("AudioWorkletNode", MockAudioWorkletNode);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      wsUrl: "ws://unused.example.test",
      sessionToken: "voice-session-token",
      expiresIn: 300,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => mediaStream),
      },
    });
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("includes hiveId when subscribing to session events", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    await renderNode(<VoiceHookHarness hiveId="11111111-1111-4111-8111-111111111111" />);

    const button = container.querySelector("button");
    expect(button).toBeTruthy();
    fireEvent.click(button as HTMLButtonElement);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/voice/direct",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            hiveId: "11111111-1111-4111-8111-111111111111",
          }),
        }),
      );
    });

    await waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(1);
    });

    MockWebSocket.instances[0].emit("message", {
      data: JSON.stringify({ type: "session", id: "session-123" }),
    } as MessageEvent);

    await waitFor(() => {
      expect(MockEventSource.instances[0]?.url).toBe(
        "/api/voice/sessions/session-123/events?hiveId=11111111-1111-4111-8111-111111111111",
      );
    });
  });
});
