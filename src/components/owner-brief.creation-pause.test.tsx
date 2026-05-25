// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HiveCreationPauseButton } from "./hive-creation-pause-button";

function renderButton() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <HiveCreationPauseButton hiveId="hive-1" />
    </QueryClientProvider>,
  );
}

function pausePayload(paused = true) {
  return {
    paused,
    reason: paused ? "Manual recovery lock" : null,
    pausedBy: "owner",
    updatedAt: new Date().toISOString(),
    operatingState: paused ? "paused" : "normal",
    pausedScheduleIds: paused ? ["schedule-1"] : [],
    resumeApproval: {
      status: paused ? "approval_needed" : "not_required",
      decisionId: null,
      requestedBy: null,
      requestedAt: null,
      approvedBy: null,
      approvedAt: null,
    },
  };
}

describe("HiveCreationPauseButton", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({ data: pausePayload() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows request resume approval when the hive is paused without clearance", async () => {
    renderButton();

    expect(await screen.findByRole("button", { name: /Request resume approval/i })).toBeTruthy();
  });

  it("shows approval pending when a resume approval is already open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({
        data: {
          ...pausePayload(),
          resumeApproval: {
            status: "pending",
            decisionId: "decision-1",
            requestedBy: "owner@example.com",
            requestedAt: "2026-05-20T03:00:00.000Z",
            approvedBy: null,
            approvedAt: null,
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )));

    renderButton();

    expect(await screen.findByRole("button", { name: /Approval pending/i })).toHaveProperty("disabled", true);
  });

  it("lets the owner pause the hive from the header button", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/hives/hive-1/creation-pause" && !init) {
        return new Response(JSON.stringify({ data: pausePayload(false) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/hives/hive-1/creation-pause" && init?.method === "PATCH") {
        return new Response(JSON.stringify({
          data: {
            paused: true,
            reason: "Paused from dashboard",
            pausedBy: "owner",
            updatedAt: new Date().toISOString(),
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderButton();

    fireEvent.click(await screen.findByRole("button", { name: /Pause Hive/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/hives/hive-1/creation-pause",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            paused: true,
            reason: "Paused from dashboard",
          }),
        }),
      );
    });
  });

  it("uses an approved resume decision id when resuming", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/hives/hive-1/creation-pause" && !init) {
        return new Response(JSON.stringify({
          data: {
            ...pausePayload(),
            resumeApproval: {
              status: "approved",
              decisionId: "decision-1",
              requestedBy: "owner@example.com",
              requestedAt: "2026-05-20T03:00:00.000Z",
              approvedBy: "owner-1",
              approvedAt: "2026-05-20T03:05:00.000Z",
            },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/hives/hive-1/creation-pause" && init?.method === "PATCH") {
        return new Response(JSON.stringify({
          data: {
            ...pausePayload(false),
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderButton();

    fireEvent.click(await screen.findByRole("button", { name: /Resume work/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/hives/hive-1/creation-pause",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            paused: false,
            approvalDecisionId: "decision-1",
          }),
        }),
      );
    });
  });
});
