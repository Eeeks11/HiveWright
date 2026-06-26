// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HiveDetailPage from "../../src/app/(dashboard)/hives/[id]/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "hive-1" }),
  usePathname: () => "/hives/hive-1",
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe("HiveDetailPage", () => {
  let originalFetch: typeof globalThis.fetch;
  let businessOsDashboardResponse: unknown | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    businessOsDashboardResponse = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/hives/hive-1") {
        return new Response(
          JSON.stringify({
            data: {
              id: "hive-1",
              slug: "alpha",
              name: "Alpha Hive",
              type: "digital",
              description: "Test hive",
              mission: "Ship alpha",
              workspacePath: null,
              createdAt: "2026-04-01T00:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }

      if (url === "/api/hives/hive-1/targets") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      if (url === "/api/hives/hive-1/business-os-dashboard") {
        if (!businessOsDashboardResponse) return new Response("not found", { status: 404 });
        return jsonResponse({ data: businessOsDashboardResponse });
      }

      if (url === "/api/connectors?hiveId=hive-1") {
        return jsonResponse({ data: [connectorFixture()] });
      }

      if (url === "/api/connector-installs?hiveId=hive-1") {
        return jsonResponse({ data: [installFixture()] });
      }

      if (url === "/api/connector-installs/install-1/actions?hiveId=hive-1") {
        return jsonResponse({ data: [actionFixture()] });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exposes the ideas route in the hive section navigation", async () => {
    renderWithQueryClient(<HiveDetailPage />);

    await waitFor(() => expect(screen.getByDisplayValue("Alpha Hive")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Targets" }).getAttribute("href")).toBe("/hives/hive-1");
    expect(screen.getByRole("link", { name: "Ideas" }).getAttribute("href")).toBe("/hives/hive-1/ideas");
    expect(screen.getByRole("link", { name: "Goals" }).getAttribute("href")).toBe("/goals?hiveId=hive-1");
    expect(screen.getByRole("link", { name: "Decisions" }).getAttribute("href")).toBe("/decisions?hiveId=hive-1");
  });

  it("shows connector health, sync, scopes, risk, and recent actions on the hive detail page", async () => {
    renderWithQueryClient(<HiveDetailPage />);

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Discord operations")).toBeTruthy());

    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText(/last tested/i)).toBeTruthy();
    expect(screen.getByText(/last sync/i)).toBeTruthy();
    expect(screen.getByText(/2 ok \/ 1 err/)).toBeTruthy();
    expect(screen.getByText("sync")).toBeTruthy();
    expect(screen.getByText("action_execute")).toBeTruthy();
    expect(screen.getByText("discord-webhook:send_message")).toBeTruthy();
    expect(screen.getByText(/Send message/).textContent).toContain("approval-gated");
    expect(screen.getByText(/send_message \/ succeeded/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View actions" }).getAttribute("href")).toBe("/setup/connectors");
    expect(screen.getByRole("button", { name: "Test Discord operations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync Discord operations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable Discord operations" })).toBeTruthy();
  });

  it("shows missing readiness evidence instead of saying no systems are below threshold", async () => {
    businessOsDashboardResponse = businessOsDashboardFixture({
      systemMaturity: {
        averageReadinessScore: null,
        readinessEvidenceState: "unknown",
        readinessEvidenceMessage: "Readiness has not been measured yet. Treat this as missing evidence, not a healthy Business OS.",
        atRiskSystems: [],
        systems: [],
      },
    });

    renderWithQueryClient(<HiveDetailPage />);

    expect(await screen.findByText("Readiness has not been measured yet. Treat this as missing evidence, not a healthy Business OS.")).toBeTruthy();
    expect(screen.queryByText("No systems below the readiness threshold.")).toBeNull();
  });

  it("shows a Business OS setup/audit CTA when a business hive has no profile yet", async () => {
    businessOsDashboardResponse = {
      status: "setup_required",
      headline: "Alpha Hive Business OS setup required",
      summary: "Test hive",
      setupRequired: {
        label: "Set up or audit this business",
        href: "/hives/hive-1/business-os/setup",
      },
    };

    renderWithQueryClient(<HiveDetailPage />);

    expect(await screen.findByRole("heading", { name: "Alpha Hive Business OS setup required" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up or audit this business" }).getAttribute("href")).toBe("/hives/hive-1/business-os/setup");
  });
});

function businessOsDashboardFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    headline: "Alpha Hive Business OS — audit command view",
    summary: "Business OS dashboard fixture.",
    mode: "existing_business",
    stage: "operating",
    ownerGoals: [],
    setupProgress: {
      label: "Existing-business audit progress",
      completedSteps: 1,
      totalSteps: 6,
      percent: 17,
      nextStep: "Finish the audit baseline and evidence sources before execution.",
    },
    auditScorecard: {
      status: "not_started",
      score: null,
      confidence: null,
      scope: [],
      evidence: [],
      knownUnknowns: [],
    },
    systemMaturity: {
      averageReadinessScore: 80,
      readinessEvidenceState: "measured",
      readinessEvidenceMessage: "Measured systems are currently above the readiness threshold.",
      atRiskSystems: [],
      systems: [],
    },
    priorityActions: [],
    approvalsRequired: [],
    openGaps: [],
    agentActivity: [],
    changedSinceLastReview: [],
    governance: {
      aiSpendBudgetLabel: "AI spend budget configured",
    },
    ownerNextReviewChecklist: [],
    ...overrides,
  };
}

function connectorFixture() {
  return {
    slug: "discord-webhook",
    name: "Discord webhook",
    category: "messaging",
    description: "Post messages to Discord",
    icon: null,
    authType: "webhook",
    setupFields: [
      { key: "webhookUrl", label: "Webhook URL", type: "password", required: true },
      { key: "defaultUsername", label: "Default username", type: "text", required: false },
    ],
    scopes: [
      { key: "discord-webhook:test_connection", label: "Test connection", kind: "read", required: true },
      { key: "discord-webhook:send_message", label: "Send message", kind: "send", required: false },
    ],
    capabilities: ["health", "sync", "action_execute"],
    operations: [
      {
        slug: "send_message",
        label: "Send message",
        governance: { effectType: "notify", defaultDecision: "require_approval", riskTier: "medium" },
        outputSummary: "Posts a message.",
      },
    ],
  };
}

function installFixture() {
  return {
    id: "install-1",
    hiveId: "hive-1",
    connectorSlug: "discord-webhook",
    connectorName: "Discord webhook",
    displayName: "Discord operations",
    config: { defaultUsername: "HiveWright" },
    credentialConfigured: true,
    status: "active",
    lastTestedAt: "2026-05-12T01:00:00.000Z",
    lastSyncedAt: "2026-05-12T03:00:00.000Z",
    lastError: null,
    lastSyncError: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    successes7d: 2,
    errors7d: 1,
    grantedScopes: ["discord-webhook:test_connection", "discord-webhook:send_message"],
    capabilities: ["health", "sync", "action_execute"],
  };
}

function actionFixture() {
  return {
    id: "action-1",
    kind: "external_action_request",
    connector: "discord-webhook",
    operation: "send_message",
    state: "succeeded",
    roleSlug: "ea",
    policyId: "policy-1",
    policyReason: "matched action policy policy-1",
    createdAt: "2026-05-12T02:00:00.000Z",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
