"use client";

import { Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";

interface HiveRecordOption {
  value: string;
  label: string;
  family?: string;
}

interface HiveRecordOptions {
  kind: string;
  heading: string;
  emptyState: string;
  familyOptions: HiveRecordOption[];
  typeOptions: HiveRecordOption[];
}

interface HiveRecord {
  id: string;
  hiveId: string;
  sourceConnector: string;
  family: string;
  type: string;
  typeLabel?: string;
  title: string | null;
  occurredAt: string | null;
  amountCents: number | null;
  currency: string | null;
  counterparty: string | null;
  status: string | null;
  summary: string | null;
  notes: string | null;
}

interface HiveRecordImportError {
  rowNumber: number;
  message: string;
}

const DEFAULT_OPTIONS: HiveRecordOptions = {
  kind: "business",
  heading: "Hive records",
  emptyState: "Add records or goals so this hive has a clear operating trail.",
  familyOptions: [{ value: "note", label: "Note" }],
  typeOptions: [{ value: "note", label: "Note", family: "note" }],
};

export function HiveRecordsPanel({
  hiveId,
  hiveKind,
}: {
  hiveId: string;
  hiveKind: string;
}) {
  const [records, setRecords] = useState<HiveRecord[]>([]);
  const [options, setOptions] = useState<HiveRecordOptions>(DEFAULT_OPTIONS);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [importState, setImportState] = useState<"idle" | "importing" | "imported" | "error">("idle");
  const [importSummary, setImportSummary] = useState<{ imported: number; rejected: number } | null>(null);
  const [importErrors, setImportErrors] = useState<HiveRecordImportError[]>([]);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [selectedType, setSelectedType] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selectedTypeOption = useMemo(
    () => options.typeOptions.find((option) => option.value === selectedType) ?? options.typeOptions[0],
    [options.typeOptions, selectedType],
  );

  const reload = useCallback(async () => {
    setLoadState("loading");
    setError(null);
    try {
      const res = await fetch(`/api/hives/${hiveId}/records`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Records failed with ${res.status}`);
      const nextOptions = body.data?.options ?? DEFAULT_OPTIONS;
      setOptions(nextOptions);
      setRecords(body.data?.records ?? []);
      setSelectedType((current) => current || nextOptions.typeOptions?.[0]?.value || "note");
      setLoadState("loaded");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load records");
      setLoadState("error");
    }
  }, [hiveId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const addManualRecord = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = String(form.get("amount") ?? "").trim();
    const occurredAt = String(form.get("occurredAt") ?? "").trim();
    const payload = {
      family: selectedTypeOption?.family ?? "note",
      type: selectedTypeOption?.value ?? selectedType,
      title: String(form.get("title") ?? ""),
      occurredAt: occurredAt ? new Date(`${occurredAt}T00:00:00`).toISOString() : null,
      amount: amount ? Number(amount) : null,
      currency: String(form.get("currency") ?? "").trim() || null,
      counterparty: String(form.get("counterparty") ?? "").trim() || null,
      status: String(form.get("status") ?? "").trim() || null,
      summary: String(form.get("summary") ?? "").trim() || null,
      notes: String(form.get("notes") ?? "").trim() || null,
    };

    setSaveState("saving");
    setError(null);
    try {
      const res = await fetch(`/api/hives/${hiveId}/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Save failed with ${res.status}`);
      event.currentTarget.reset();
      setRecords((current) => [body.data, ...current].filter(Boolean));
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to add record");
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 4000);
    }
  };

  const importCsvRecords = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!csvFile || csvFile.size === 0) {
      setError("Choose a CSV file to import");
      setImportState("error");
      return;
    }

    setImportState("importing");
    setImportSummary(null);
    setImportErrors([]);
    setError(null);
    try {
      const upload = new FormData();
      upload.append("file", csvFile);
      const res = await fetch(`/api/hives/${hiveId}/records/import`, {
        method: "POST",
        body: upload,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Import failed with ${res.status}`);
      setRecords((current) => [...(body.data?.records ?? []), ...current].filter(Boolean));
      setImportSummary({
        imported: body.data?.imported ?? 0,
        rejected: body.data?.rejected ?? 0,
      });
      setImportErrors(body.data?.errors ?? []);
      formElement.reset();
      setCsvFile(null);
      setImportState("imported");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Failed to import CSV");
      setImportState("error");
    }
  };

  const heading = options.heading || headingForKind(hiveKind);

  return (
    <section className="space-y-4 rounded-lg border p-6">
      <div>
        <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">{heading}</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Manual entries give this hive a lightweight event trail for context, goals, and later automation.
        </p>
      </div>

      <form onSubmit={addManualRecord} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Record type</span>
            <select
              value={selectedType || options.typeOptions[0]?.value || "note"}
              onChange={(event) => setSelectedType(event.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            >
              {options.typeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Record title</span>
            <input
              name="title"
              required
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              placeholder="What happened?"
            />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Occurred</span>
            <input
              name="occurredAt"
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Amount</span>
            <input
              name="amount"
              type="number"
              step="0.01"
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Currency</span>
            <input
              name="currency"
              maxLength={16}
              className="w-full rounded-md border px-3 py-2 text-sm uppercase dark:bg-zinc-800"
              placeholder="USD"
            />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Counterparty</span>
            <input
              name="counterparty"
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Status</span>
            <input
              name="status"
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              placeholder="open, done, blocked"
            />
          </label>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-200">Summary</span>
          <textarea
            name="summary"
            rows={2}
            className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          />
        </label>

        <label className="block space-y-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-200">Notes</span>
          <textarea
            name="notes"
            rows={3}
            className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saveState === "saving"}>
            <Plus aria-hidden="true" />
            {saveState === "saving" ? "Adding..." : "Add record"}
          </Button>
          {saveState === "saved" && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
          {saveState === "error" && <span className="text-sm text-red-600 dark:text-red-400">Save failed</span>}
        </div>
      </form>

      <form onSubmit={importCsvRecords} className="space-y-3 border-t pt-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Import CSV</span>
            <input
              name="file"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setCsvFile(event.target.files?.[0] ?? null)}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            />
          </label>
          <Button type="submit" disabled={importState === "importing"}>
            <Upload aria-hidden="true" />
            {importState === "importing" ? "Importing..." : "Import records"}
          </Button>
        </div>
        {importSummary && (
          <p className="text-sm text-green-700 dark:text-green-300">
            Imported {importSummary.imported} records; rejected {importSummary.rejected}{" "}
            {importSummary.rejected === 1 ? "row" : "rows"}.
          </p>
        )}
        {importErrors.length > 0 && (
          <ul className="space-y-1 text-sm text-red-600 dark:text-red-400">
            {importErrors.slice(0, 5).map((entry) => (
              <li key={`${entry.rowNumber}-${entry.message}`}>
                Row {entry.rowNumber}: {entry.message}
              </li>
            ))}
          </ul>
        )}
      </form>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="space-y-3">
        {loadState === "loading" && <p className="text-sm text-zinc-400">Loading records...</p>}
        {loadState !== "loading" && records.length === 0 && (
          <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500 dark:text-zinc-400">
            {options.emptyState}
          </p>
        )}
        {records.map((record) => (
          <article key={record.id} className="rounded-md border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                  {record.title || record.typeLabel || record.type}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {(record.typeLabel || record.type).replace("_", " ")}
                  {record.status ? ` - ${record.status}` : ""}
                </p>
              </div>
              {record.occurredAt && (
                <time className="text-xs text-zinc-500 dark:text-zinc-400">
                  {new Date(record.occurredAt).toLocaleDateString()}
                </time>
              )}
            </div>
            {record.summary && <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{record.summary}</p>}
            {(record.amountCents !== null || record.counterparty) && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                {record.amountCents !== null
                  ? `${record.currency ?? ""} ${(record.amountCents / 100).toFixed(2)}`.trim()
                  : ""}
                {record.counterparty ? ` ${record.counterparty}` : ""}
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function headingForKind(kind: string): string {
  switch (kind) {
    case "research":
      return "Research records";
    case "creative":
      return "Creative records";
    case "personal_assistant":
      return "Assistant records";
    case "personal_project":
      return "Project records";
    default:
      return "Hive records";
  }
}
