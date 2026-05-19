"use client";

import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";

type HivePortablePackage = {
  manifest?: { kind?: string; version?: number; source?: string };
  hive?: { slug?: string; name?: string; type?: string; mission?: string | null };
  roles?: unknown[];
  connectors?: unknown[];
  policies?: unknown[];
  schedules?: unknown[];
  goals?: unknown[];
  tasks?: unknown[];
};

type ImportPreview = {
  canImport: boolean;
  target: { slug: string; name: string };
  collisions: Array<{ field: "slug"; value: string; strategy: "reject" | "rename" }>;
  missingEnvInputs: string[];
  missingRoles: string[];
  warnings: string[];
  summary: {
    roles: number;
    connectors: number;
    policies: number;
    schedules: number;
    goals: number;
    tasks: number;
  };
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 58);
}

async function readJsonResponse(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error ?? `Request failed with ${res.status}`);
  return body;
}

export default function HiveTemplateImportPage() {
  const router = useRouter();
  const { refreshHives } = useHiveContext();
  const [rawPackage, setRawPackage] = useState("");
  const [hivePackage, setHivePackage] = useState<HivePortablePackage | null>(null);
  const [targetName, setTargetName] = useState("");
  const [targetSlug, setTargetSlug] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [status, setStatus] = useState<"idle" | "parsing" | "previewing" | "importing" | "imported" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const packageSummary = useMemo(() => {
    if (!hivePackage) return null;
    return {
      name: hivePackage.hive?.name ?? "Untitled hive template",
      slug: hivePackage.hive?.slug ?? "unknown-slug",
      kind: hivePackage.manifest?.kind ?? "unknown package",
      version: hivePackage.manifest?.version ?? "?",
      roles: hivePackage.roles?.length ?? 0,
      connectors: hivePackage.connectors?.length ?? 0,
      policies: hivePackage.policies?.length ?? 0,
      schedules: hivePackage.schedules?.length ?? 0,
      goals: hivePackage.goals?.length ?? 0,
      tasks: hivePackage.tasks?.length ?? 0,
    };
  }, [hivePackage]);

  const parsePackageText = (text: string) => {
    setStatus("parsing");
    setMessage(null);
    setPreview(null);
    try {
      const parsed = JSON.parse(text) as HivePortablePackage;
      if (parsed.manifest?.kind !== "hivewright.hive-template") {
        throw new Error("This is not a HiveWright hive template package.");
      }
      setRawPackage(JSON.stringify(parsed, null, 2));
      setHivePackage(parsed);
      const sourceName = parsed.hive?.name?.trim() || "Imported Hive";
      const sourceSlug = parsed.hive?.slug?.trim() || slugify(sourceName) || "imported-hive";
      setTargetName(`${sourceName} Copy`);
      setTargetSlug(`${slugify(sourceSlug) || "imported-hive"}-copy`.slice(0, 64));
      setStatus("idle");
      setMessage("Template loaded. Preview it before importing.");
    } catch (error) {
      setHivePackage(null);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not parse template JSON.");
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    parsePackageText(await file.text());
  };

  const runPreview = async () => {
    if (!hivePackage) {
      parsePackageText(rawPackage);
      return;
    }
    setStatus("previewing");
    setMessage(null);
    try {
      const body = await fetch("/api/hives/portability/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package: hivePackage,
          name: targetName,
          slug: targetSlug,
          collisionStrategy: "reject",
        }),
      }).then(readJsonResponse);
      setPreview(body.data);
      setStatus("idle");
      setMessage(body.data.canImport ? "Preview clean. Ready to import." : "Preview found issues to resolve before import.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Preview failed.");
    }
  };

  const importTemplate = async () => {
    if (!hivePackage || !preview?.canImport) return;
    setStatus("importing");
    setMessage(null);
    try {
      const body = await fetch("/api/hives/portability/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          package: hivePackage,
          name: targetName,
          slug: targetSlug,
          collisionStrategy: "reject",
        }),
      }).then(readJsonResponse);
      const newHiveId = body.data?.hive?.id;
      if (newHiveId) {
        await refreshHives?.(newHiveId);
        router.push(`/hives/${newHiveId}`);
        return;
      }
      setStatus("imported");
      setMessage("Imported, but the response did not include a hive id. Go back to Hives to find it.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Import failed.");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-amber-900 dark:text-amber-100">Import hive template</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Create a new hive from a safe template package. Credentials and runtime history are not imported.
          </p>
        </div>
        <Link
          href="/hives"
          className="rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          Back to hives
        </Link>
      </div>

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">1. Load template JSON</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Upload an exported `.json` package or paste the template JSON below.
          </p>
        </div>
        <input
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
          className="block w-full cursor-pointer rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
        />
        <textarea
          value={rawPackage}
          onChange={(event) => {
            setRawPackage(event.target.value);
            setHivePackage(null);
            setPreview(null);
          }}
          rows={10}
          className="w-full rounded-md border px-3 py-2 font-mono text-xs dark:bg-zinc-800"
          placeholder="Paste hivewright.hive-template JSON here…"
        />
        <button
          type="button"
          onClick={() => parsePackageText(rawPackage)}
          disabled={!rawPackage.trim() || status === "parsing"}
          className="cursor-pointer rounded-md border px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
        >
          {status === "parsing" ? "Loading…" : "Load template"}
        </button>
      </section>

      {packageSummary && (
        <section className="space-y-4 rounded-lg border p-6">
          <div>
            <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">2. New hive details</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Source: <span className="font-medium">{packageSummary.name}</span> · <span className="font-mono">{packageSummary.slug}</span> · package v{packageSummary.version}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">New hive name</span>
              <input
                value={targetName}
                onChange={(event) => {
                  setTargetName(event.target.value);
                  setPreview(null);
                }}
                className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">New hive slug</span>
              <input
                value={targetSlug}
                onChange={(event) => {
                  setTargetSlug(slugify(event.target.value));
                  setPreview(null);
                }}
                className="w-full rounded-md border px-3 py-2 font-mono text-sm dark:bg-zinc-800"
              />
            </label>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">Roles: {packageSummary.roles}</div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">Connectors: {packageSummary.connectors}</div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">Policies: {packageSummary.policies}</div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">Schedules: {packageSummary.schedules}</div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">Starter goals: {packageSummary.goals}</div>
            <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">Starter tasks: {packageSummary.tasks}</div>
          </div>
          <button
            type="button"
            onClick={runPreview}
            disabled={!targetName.trim() || !targetSlug.trim() || status === "previewing"}
            className="cursor-pointer rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {status === "previewing" ? "Previewing…" : "Preview import"}
          </button>
        </section>
      )}

      {preview && (
        <section className="space-y-4 rounded-lg border p-6">
          <div>
            <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">3. Preview</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Target: <span className="font-medium">{preview.target.name}</span> · <span className="font-mono">{preview.target.slug}</span>
            </p>
          </div>

          <div className={`rounded-md border p-4 text-sm ${preview.canImport ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-200" : "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200"}`}>
            {preview.canImport ? "Ready to import." : "Resolve blocking issues before import."}
          </div>

          {preview.collisions.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              <p className="font-medium">Slug collision</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {preview.collisions.map((collision) => (
                  <li key={`${collision.field}:${collision.value}`}>`{collision.value}` already exists. Change the new hive slug.</li>
                ))}
              </ul>
            </div>
          )}

          {preview.missingRoles.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              <p className="font-medium">Missing role templates</p>
              <p className="mt-1 font-mono">{preview.missingRoles.join(", ")}</p>
            </div>
          )}

          {preview.missingEnvInputs.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="font-medium">Reconnect needed after import</p>
              <p className="mt-1">Connector secrets are intentionally omitted. Re-enter these after import:</p>
              <p className="mt-2 font-mono text-xs">{preview.missingEnvInputs.join(", ")}</p>
            </div>
          )}

          {preview.warnings.length > 0 && (
            <div className="rounded-md bg-zinc-50 p-4 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
              <p className="font-medium text-zinc-800 dark:text-zinc-100">What is not imported</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={importTemplate}
            disabled={!preview.canImport || status === "importing"}
            className="cursor-pointer rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "importing" ? "Importing…" : "Import as new hive"}
          </button>
        </section>
      )}

      {message && (
        <p className={`rounded-md border p-3 text-sm ${status === "error" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"}`}>
          {message}
        </p>
      )}
    </div>
  );
}
