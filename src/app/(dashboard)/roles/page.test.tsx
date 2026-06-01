/* @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: { id: "hive-1", name: "Test Hive" },
  }),
}));

vi.mock("@/components/provision-badge", () => ({
  ProvisionBadge: () => <span data-testid="provision-badge" />,
}));

vi.mock("@/components/agent-observability-panel", () => ({
  AgentObservabilityPanel: () => null,
}));

vi.mock("@/components/runs-table", () => ({
  RunsTable: ({ rows, emptyState }: {
    rows: Array<{
      id: string;
      title: ReactNode;
      actions?: ReactNode;
      expandedContent?: ReactNode;
    }>;
    emptyState?: ReactNode;
  }) => (
    <div>
      {rows.length === 0 ? emptyState : rows.map((row) => (
        <section key={row.id} aria-label={row.id}>
          <div>{row.title}</div>
          <div>{row.actions}</div>
          <div>{row.expandedContent}</div>
        </section>
      ))}
    </div>
  ),
}));

import RolesPage from "./page";

const fetchMock = vi.fn();

const role = {
  slug: "dev-agent",
  name: "Dev Agent",
  department: "engineering",
  type: "executor",
  recommendedModel: "openai-codex/gpt-5.5",
  fallbackModel: null,
  adapterType: "codex",
  fallbackAdapterType: null,
  skills: [],
  active: true,
  toolsConfig: null,
  concurrencyLimit: 1,
  provisionStatus: { satisfied: true, fixable: false, reason: null },
  activeCount: 0,
  runningCount: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/roles") && init?.method === "POST") {
      return Promise.resolve(jsonResponse({ error: "save rejected" }, 500));
    }
    if (url.startsWith("/api/roles")) {
      return Promise.resolve(jsonResponse({ data: [role] }));
    }
    if (url === "/api/ollama/models") {
      return Promise.resolve(jsonResponse({ data: [] }));
    }
    if (url === "/api/mcp-catalog") {
      return Promise.resolve(jsonResponse({ data: [] }));
    }
    if (url.startsWith("/api/model-setup")) {
      return Promise.resolve(jsonResponse({ data: { models: [] } }));
    }
    if (url === "/api/adapter-config") {
      return Promise.resolve(jsonResponse({ data: [] }));
    }
    return Promise.resolve(jsonResponse({ data: [] }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("RolesPage", () => {
  it("keeps role edits visible and shows the server error when save fails", async () => {
    render(<RolesPage />);

    const concurrencyInput = await screen.findByTitle(
      "Max tasks of this role the dispatcher will run in parallel",
    );
    fireEvent.change(concurrencyInput, { target: { value: "3" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Role save failed: save rejected");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect((concurrencyInput as HTMLInputElement).value).toBe("3");
  });
});
