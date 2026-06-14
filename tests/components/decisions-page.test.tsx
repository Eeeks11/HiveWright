// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DecisionsPage from "../../src/app/(dashboard)/decisions/page";

const HIVE_ID = "b151c196-5883-4c43-b6e7-d2ed181d2f50";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/decisions",
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: {
      id: HIVE_ID,
      name: "HiveWright",
      slug: "hivewright",
      type: "business",
    },
    hives: [
      {
        id: HIVE_ID,
        name: "HiveWright",
        slug: "hivewright",
        type: "business",
      },
    ],
    loading: false,
    hasProvider: true,
  }),
}));

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    title: "Choose Gemini CLI authentication",
    context: "The adapter needs a runtime auth path.",
    recommendation: "Use the owner-scoped GCA login.",
    options: [],
    priority: "urgent",
    status: "pending",
    kind: "decision",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function okJson(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("<DecisionsPage>", () => {
  beforeEach(() => {
    vi.stubGlobal("alert", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders named decision options as primary actions and keeps discuss available", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/decisions?")) {
        return okJson({
          data: [
            decision({
              options: [
                {
                  key: "service-account",
                  title: "Use service account",
                  consequence: "Fastest automation path, but needs credential storage.",
                  response: "approved",
                },
                {
                  key: "gca-login",
                  label: "Use GCA login",
                  description: "Owner authenticates locally and the supervisor can continue.",
                  response: "approved",
                },
                {
                  key: "defer",
                  label: "Defer adapter work",
                  consequence: "Leaves the goal parked until a better auth path exists.",
                  response: "rejected",
                },
              ],
            }),
          ],
        });
      }
      if (url === "/api/decisions/decision-1/respond" && init?.method === "POST") {
        return okJson({ data: { status: "resolved" } });
      }
      if (url === "/api/decisions/decision-1/messages") {
        return okJson({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionsPage />);

    expect((await screen.findAllByText("Question")).length).toBeGreaterThan(0);
    expect(screen.getByText("Recommended answer")).toBeTruthy();
    expect(screen.getByText("What happens next")).toBeTruthy();
    expect(screen.getByText("Context / evidence")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Use service account/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use GCA login/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Defer adapter work/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discuss" })).toBeTruthy();
    expect(screen.getByText(/HiveWright will record your answer and continue the blocked work/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Use GCA login/i }));

    await waitFor(() => {
      const respondCall = fetchMock.mock.calls.find(([url]) =>
        String(url) === "/api/decisions/decision-1/respond"
      );
      expect(respondCall).toBeDefined();
      const payload = JSON.parse(String(respondCall?.[1]?.body));
      expect(payload).toMatchObject({
        response: "approved",
        selectedOptionKey: "gca-login",
        selectedOptionLabel: "Use GCA login",
      });
    });
  });

  it("keeps approve, discuss, and reject actions for decisions without named options", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/decisions?")) {
          return okJson({ data: [decision()] });
        }
        if (url === "/api/decisions/decision-1/messages") {
          return okJson({ data: [] });
        }
        return okJson({ data: {} });
      }),
    );

    render(<DecisionsPage />);

    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discuss" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("adds the include internal/system query flag only when the owner turns on the toggle", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/decisions?")) {
        return okJson({ data: [decision()] });
      }
      if (url === "/api/decisions/decision-1/activity") {
        return okJson({ data: [] });
      }
      return okJson({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionsPage />);

    await screen.findByRole("link", { name: "Choose Gemini CLI authentication" });

    const listCallsBeforeToggle = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith("/api/decisions?"));
    expect(listCallsBeforeToggle[0]).toContain("includeInternalSystem=false");

    fireEvent.click(screen.getByRole("checkbox", { name: /include internal\/system/i }));

    await waitFor(() => {
      const listCalls = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.startsWith("/api/decisions?"));
      expect(listCalls.at(-1)).toContain("includeInternalSystem=true");
    });
  });

  it("keeps raw internal kinds out of the owner-readable row metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/decisions?")) {
          return okJson({ data: [decision({ kind: "supervisor_flagged" })] });
        }
        if (url === "/api/decisions/decision-1/activity") {
          return okJson({ data: [] });
        }
        if (url === "/api/decisions/decision-1/messages") {
          return okJson({ data: [] });
        }
        return okJson({ data: [] });
      }),
    );

    render(<DecisionsPage />);

    await screen.findByRole("link", { name: "Choose Gemini CLI authentication" });
    expect(screen.queryByText(/^supervisor_flagged$/i)).toBeNull();
    expect(screen.queryByText(/^decision$/i)).toBeNull();
  });

  it("renders decision activity from all timeline sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/decisions?")) {
          return okJson({ data: [decision()] });
        }
        if (url === "/api/decisions/decision-1/activity") {
          return okJson({
            data: [
              {
                id: "m1",
                timestamp: "2026-04-30T15:15:03.300Z",
                actor: "owner",
                summary: "Make it more honeycomb.",
                sourceType: "decision_message",
                sourceId: "message-1",
              },
              {
                id: "wake1",
                timestamp: "2026-04-30T15:15:04.000Z",
                actor: "system mirror",
                summary: "Mirrored owner discussion to the linked goal and woke the supervisor.",
                sourceType: "decision_message",
                sourceId: "message-1",
              },
              {
                id: "g1",
                timestamp: "2026-04-30T15:16:00.000Z",
                actor: "supervisor",
                summary: "Sprint 9 plan revision 21 acknowledges owner direction.",
                sourceType: "goal_comment",
                sourceId: "goal-comment-1",
              },
              {
                id: "ea1",
                timestamp: "2026-04-30T15:17:00.000Z",
                actor: "ea-resolver",
                summary: "EA recorded outcome: use the owner direction.",
                sourceType: "decision",
                sourceId: "decision-1",
              },
            ],
          });
        }
        if (url === "/api/decisions/decision-1/messages") {
          return okJson({ data: [] });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    render(<DecisionsPage />);

    expect(await screen.findByText("Make it more honeycomb.")).toBeTruthy();
    expect(screen.getByText(/woke the supervisor/i)).toBeTruthy();
    expect(screen.getByText(/Sprint 9 plan revision 21/i)).toBeTruthy();
    expect(screen.getByText(/EA recorded outcome/i)).toBeTruthy();
  });

  it("sends Discuss comments only through the respond endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/decisions?")) {
        return okJson({ data: [decision()] });
      }
      if (url === "/api/decisions/decision-1/activity") {
        return okJson({ data: [] });
      }
      if (url === "/api/decisions/decision-1/messages" && !init) {
        return okJson({ data: [] });
      }
      if (url === "/api/decisions/decision-1/respond" && init?.method === "POST") {
        return okJson({ data: { status: "pending" } });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionsPage />);

    expect(await screen.findByRole("link", { name: "Choose Gemini CLI authentication" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discuss" }));
    const input = await screen.findByPlaceholderText("Type a message...");
    fireEvent.change(input, {
      target: { value: "Use the faint honeycomb direction." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const respondPosts = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === "/api/decisions/decision-1/respond" && init?.method === "POST",
      );
      expect(respondPosts).toHaveLength(1);
      expect(JSON.parse(String(respondPosts[0][1]?.body))).toEqual({
        hiveId: HIVE_ID,
        response: "discussed",
        comment: "Use the faint honeycomb direction.",
      });
    });

    const messagePosts = fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === "/api/decisions/decision-1/messages" && init?.method === "POST",
    );
    expect(messagePosts).toHaveLength(0);
  });
});
