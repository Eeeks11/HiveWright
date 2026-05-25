// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HiveRecordsPanel } from "@/components/hives/hive-records-panel";

describe("HiveRecordsPanel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/hives/hive-1/records" && (!init || init.method === undefined || init.method === "GET")) {
        return new Response(JSON.stringify({
          data: {
            options: {
              kind: "research",
              familyOptions: [{ value: "evidence", label: "Evidence" }],
              typeOptions: [{ value: "finding", label: "Finding", family: "evidence" }],
              emptyState: "Add research records or goals so this hive has evidence to work from.",
            },
            records: [],
          },
        }), { status: 200 });
      }

      if (url === "/api/hives/hive-1/records" && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            id: "record-1",
            hiveId: "hive-1",
            sourceConnector: "manual",
            family: "evidence",
            type: "finding",
            title: "Interview insight",
          },
        }), { status: 201 });
      }

      if (url === "/api/hives/hive-1/records/import" && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            imported: 2,
            rejected: 1,
            errors: [{ rowNumber: 4, message: "title is required" }],
            records: [
              {
                id: "record-2",
                hiveId: "hive-1",
                sourceConnector: "csv_import",
                family: "evidence",
                type: "finding",
                title: "CSV finding",
              },
            ],
          },
        }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses kind-adaptive empty-state language and submits manual records", async () => {
    render(<HiveRecordsPanel hiveId="hive-1" hiveKind="research" />);

    expect(await screen.findByText(/Add research records or goals/i)).toBeTruthy();
    expect(screen.queryByText(/revenue/i)).toBeNull();
    expect(screen.queryByText(/customer/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("Record title"), {
      target: { value: "Interview insight" },
    });
    fireEvent.change(screen.getByLabelText("Summary"), {
      target: { value: "Users prefer a low-friction capture flow." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add record" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/hives/hive-1/records", expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Interview insight"),
      }));
    });
  });

  it("uploads a CSV file and shows imported and rejected counts with row errors", async () => {
    render(<HiveRecordsPanel hiveId="hive-1" hiveKind="research" />);

    await screen.findByText(/Add research records or goals/i);

    const file = new File(["type,title\nfinding,CSV finding"], "records.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Import CSV"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import records" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/hives/hive-1/records/import", expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }));
    });

    expect(await screen.findByText(/Imported 2 records; rejected 1 row/i)).toBeTruthy();
    expect(screen.getByText(/Row 4: title is required/i)).toBeTruthy();
    expect(screen.getByText("CSV finding")).toBeTruthy();
  });
});
