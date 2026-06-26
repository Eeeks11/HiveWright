"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type BusinessOsStatus = {
  status: string;
  mode: "new_business" | "existing_business" | null;
  profileId: string | null;
  href: string;
};

type HiveRow = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  businessOs: BusinessOsStatus | null;
};

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

export default function BusinessOsIndexPage() {
  const [hives, setHives] = useState<HiveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/hives")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Request failed with ${res.status}`);
        return body.data ?? [];
      })
      .then((rows: HiveRow[]) => {
        if (!cancelled) setHives(rows.filter((hive) => hive.kind === "business"));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load Business OS hives");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const businessHives = hives.filter((hive) => hive.businessOs);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Owner command index</p>
        <h1 className="text-2xl font-semibold">Business OS</h1>
        <p className="max-w-3xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Business hives are listed here only when HiveWright can show the owner what state the Business OS is in and what action opens it.
        </p>
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading Business OS hives…</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!loading && !error && businessHives.length === 0 && (
        <div className="rounded-lg border p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          No business hives have a Business OS status yet. Create or audit a business hive first.
        </div>
      )}

      <div className="grid gap-3">
        {businessHives.map((hive) => (
          <section key={hive.id} className="rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">{hive.name}</h2>
                <p className="text-xs text-zinc-500">{hive.slug} · {statusLabel(hive.businessOs!.status)}</p>
              </div>
              <Link
                href={hive.businessOs!.href}
                className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800"
              >
                Open {hive.name} Business OS
              </Link>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
