// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalCommentsPanel } from "../../src/components/goal-comments-panel";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function commentsResponse(body: string) {
  return new Response(
    JSON.stringify({
      data: {
        comments: [
          {
            id: `comment-${body}`,
            goalId: "goal-1",
            body,
            createdBy: "owner",
            createdAt: "2026-07-11T00:00:00.000Z",
          },
        ],
      },
    }),
    { status: 200 },
  );
}

describe("<GoalCommentsPanel>", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("refetches for hive target changes and ignores stale responses", async () => {
    const staleHiveResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce((input, init) => {
        expect(input).toBe("/api/goals/goal-1/comments?hiveId=hive-old");
        expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
        return staleHiveResponse.promise;
      })
      .mockImplementationOnce((input, init) => {
        expect(input).toBe("/api/goals/goal-1/comments?hiveId=hive-new");
        expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(commentsResponse("new hive comment"));
      });
    globalThis.fetch = fetchMock;

    const { rerender } = render(<GoalCommentsPanel goalId="goal-1" hiveId="hive-old" />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<GoalCommentsPanel goalId="goal-1" hiveId="hive-new" />);

    expect(await screen.findByText("new hive comment")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleHiveResponse.resolve(commentsResponse("old hive stale comment"));
      await staleHiveResponse.promise;
    });

    expect(screen.getByText("new hive comment")).toBeTruthy();
    expect(screen.queryByText("old hive stale comment")).toBeNull();
  });

  it("surfaces non-OK comment history failures", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Hive access denied" }), { status: 403 }),
    ) as unknown as typeof globalThis.fetch;

    render(<GoalCommentsPanel goalId="goal-1" hiveId="hive-1" />);

    expect(await screen.findByText("Hive access denied")).toBeTruthy();
    expect(screen.getByText(/No comments yet/i)).toBeTruthy();
  });
});
