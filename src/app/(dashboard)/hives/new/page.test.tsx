/* @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import NewHiveWizard from "./page";

const fetchMock = vi.fn();

const setupOk = () => ({
  ok: true,
  json: async () => ({ data: { id: "hive-id-1" } }),
});

const emptyList = () => ({
  ok: true,
  json: async () => ({ data: [] }),
});

beforeEach(() => {
  vi.clearAllMocks();
  pushMock.mockReset();
  localStorage.clear();
  localStorage.setItem("hivewright.setupWelcomeDismissed", "true");
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/hives/setup") return Promise.resolve(setupOk());
    if (url === "/api/embedding-config/local-setup") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: {
          defaultConfig: { modelName: "nomic-embed-text-v2-moe:latest" },
          status: { ollamaReachable: true, modelInstalled: true, embeddingTest: "passed", modelName: "nomic-embed-text-v2-moe:latest", error: null },
        } }),
      });
    }
    return Promise.resolve(emptyList());
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("NewHiveWizard hive address setup", () => {
  it("asks what kind of hive is being created before the name fields", async () => {
    render(<NewHiveWizard />);

    const question = await screen.findByText("What kind of hive are you creating?");
    const nameInput = await screen.findByLabelText(/^Hive name/);

    expect(question.compareDocumentPosition(nameInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Business — make money / run commercial ops")).toBeTruthy();
    expect(screen.getByLabelText("Personal project — finish a defined project")).toBeTruthy();
    expect(screen.getByLabelText("Personal assistant — help manage recurring/admin life tasks")).toBeTruthy();
    expect(screen.getByLabelText("Research/exploration — investigate and recommend")).toBeTruthy();
    expect(screen.getByLabelText("Creative/content — produce assets and publishable work")).toBeTruthy();
  });

  it("changes setup language when a non-business hive kind is selected", async () => {
    render(<NewHiveWizard />);

    fireEvent.click(await screen.findByLabelText("Research/exploration — investigate and recommend"));

    expect(screen.getByLabelText("Research focus")).toBeTruthy();
    expect(screen.getByPlaceholderText("What uncertainty should this hive investigate?")).toBeTruthy();
    expect(screen.getByPlaceholderText("Frame the research question, compare credible sources, and recommend next steps.")).toBeTruthy();
  });

  it("uses project language instead of commercial setup language for personal project hives", async () => {
    render(<NewHiveWizard />);

    fireEvent.click(await screen.findByLabelText("Personal project — finish a defined project"));

    expect(screen.getByLabelText("Project focus")).toBeTruthy();
    expect(screen.getByLabelText("Project objective")).toBeTruthy();
    expect(screen.getByLabelText("First project goal")).toBeTruthy();
    expect(screen.queryByLabelText("Business focus")).toBeNull();
    expect(screen.queryByLabelText("Commercial objective")).toBeNull();
    expect(screen.queryByLabelText("First commercial goal")).toBeNull();
  });

  it("does not render a top-level Slug field on the setup form", async () => {
    render(<NewHiveWizard />);
    await screen.findByLabelText(/^Hive name/);
    expect(screen.queryByLabelText(/^slug/i)).toBeNull();
  });

  it("hides the custom hive address control behind a closed Advanced disclosure by default", async () => {
    render(<NewHiveWizard />);
    const summary = await screen.findByText("Advanced");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
  });

  it("derives the hive address from the hive name", async () => {
    render(<NewHiveWizard />);
    const nameInput = (await screen.findByLabelText(/^Hive name/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Hello World!" } });

    fireEvent.click(screen.getByText("Advanced"));
    const addressInput = (await screen.findByLabelText("Custom hive address")) as HTMLInputElement;
    expect(addressInput.value).toBe("hello-world");
  });

  it("preserves the custom hive address after subsequent name changes", async () => {
    render(<NewHiveWizard />);
    const nameInput = (await screen.findByLabelText(/^Hive name/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "First name" } });

    fireEvent.click(screen.getByText("Advanced"));
    const addressInput = (await screen.findByLabelText("Custom hive address")) as HTMLInputElement;
    expect(addressInput.value).toBe("first-name");

    fireEvent.change(addressInput, { target: { value: "my-custom-address" } });
    expect(addressInput.value).toBe("my-custom-address");

    fireEvent.change(nameInput, { target: { value: "A different name" } });
    expect(addressInput.value).toBe("my-custom-address");
  });

  it("submits the generated hive address derived from the hive name", async () => {
    render(<NewHiveWizard />);
    const nameInput = (await screen.findByLabelText(/^Hive name/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Owner Acme Co." } });

    const typeSelect = screen.getByLabelText(/^Type/) as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "physical" } });

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    }

    const createButton = await screen.findByRole("button", { name: /Create Hive/ });
    fireEvent.click(createButton);

    await waitFor(() => {
      const setupCall = fetchMock.mock.calls.find(([url]) => url === "/api/hives/setup");
      expect(setupCall).toBeDefined();
    });

    const setupCall = fetchMock.mock.calls.find(([url]) => url === "/api/hives/setup")!;
    const body = JSON.parse(setupCall[1].body);
    expect(body.hive.name).toBe("Owner Acme Co.");
    expect(body.hive.slug).toBe("owner-acme-co");
    expect(body.hive.kind).toBe("business");
  });

  it("asks operating profile questions before model routing choices", async () => {
    render(<NewHiveWizard />);
    fireEvent.change(await screen.findByLabelText(/^Hive name/), { target: { value: "Operating First" } });

    fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

    expect(await screen.findByRole("heading", { name: "Set working preferences" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose agent runtimes" })).toBeNull();
  });

  it("uses the final step as a dashboard handoff and opens the new hive dashboard after setup", async () => {
    render(<NewHiveWizard />);
    fireEvent.change(await screen.findByLabelText(/^Hive name/), { target: { value: "Dashboard Hive" } });
    fireEvent.change(screen.getByLabelText(/^Type/) as HTMLSelectElement, {
      target: { value: "physical" },
    });

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    }

    expect(await screen.findByRole("heading", { name: "Dashboard handoff" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Create Hive/ }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/hives/hive-id-1"));
  });

  it("submits the selected hive kind in the setup payload", async () => {
    render(<NewHiveWizard />);
    fireEvent.click(await screen.findByLabelText("Creative/content — produce assets and publishable work"));
    fireEvent.change(screen.getByLabelText(/^Hive name/), { target: { value: "Creative Studio" } });
    fireEvent.change(screen.getByLabelText(/^Type/) as HTMLSelectElement, {
      target: { value: "physical" },
    });

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    }

    fireEvent.click(await screen.findByRole("button", { name: /Create Hive/ }));

    await waitFor(() => {
      const setupCall = fetchMock.mock.calls.find(([url]) => url === "/api/hives/setup");
      expect(setupCall).toBeDefined();
    });

    const setupCall = fetchMock.mock.calls.find(([url]) => url === "/api/hives/setup")!;
    const body = JSON.parse(setupCall[1].body);
    expect(body.hive.kind).toBe("creative");
  });

  it("does not display the word slug anywhere in the rendered setup or review UI", async () => {
    const { container } = render(<NewHiveWizard />);
    await screen.findByLabelText(/^Hive name/);

    const visibleText = () => (container.textContent ?? "").toLowerCase();
    expect(visibleText()).not.toContain("slug");

    fireEvent.click(screen.getByText("Advanced"));
    expect(visibleText()).not.toContain("slug");

    fireEvent.change(screen.getByLabelText(/^Hive name/), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(/^Type/) as HTMLSelectElement, {
      target: { value: "physical" },
    });

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    }

    await screen.findByRole("button", { name: /Create Hive/ });
    expect(visibleText()).not.toContain("slug");
  });
});
