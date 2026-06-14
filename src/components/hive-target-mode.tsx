"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";

type Hive = {
  id: string;
  slug: string;
  name: string;
  type: string;
};

function appendTargetHiveId(path: string, targetHiveId: string | null): string {
  if (!targetHiveId) return path;
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("targetHiveId", targetHiveId);
  const queryString = params.toString();
  return queryString ? `${base}?${queryString}` : base;
}

function currentSection(pathname: string | null): "ideas" | "initiatives" | "files" | null {
  if (!pathname) return null;
  if (pathname.endsWith("/ideas")) return "ideas";
  if (pathname.endsWith("/initiatives")) return "initiatives";
  if (pathname.endsWith("/files")) return "files";
  return null;
}

export function useResolvedHiveTarget(routeHiveId: string | null | undefined) {
  const pathname = usePathname();
  const { hives, selected: activeHive, loading, hasProvider } = useHiveContext();
  const routeId = typeof routeHiveId === "string" && routeHiveId.trim() ? routeHiveId : null;

  return useMemo(() => {
    const targetHive = routeId ? hives.find((hive) => hive.id === routeId) ?? null : null;
    const providerHasDirectory = Boolean(hasProvider && !loading && hives.length > 0);
    const isUnresolvedTarget = Boolean(providerHasDirectory && routeId && !targetHive);
    const isTargetingDifferentHive = Boolean(targetHive && activeHive && targetHive.id !== activeHive.id);
    const effectiveHiveId = isUnresolvedTarget ? null : routeId;
    const targetQueryHiveId = isTargetingDifferentHive ? targetHive?.id ?? null : null;
    const section = currentSection(pathname);
    const exitTargetHref = activeHive
      ? `/hives/${activeHive.id}${section ? `/${section}` : ""}`
      : "/hives";

    return {
      activeHive: activeHive ?? null,
      targetHive,
      effectiveHiveId,
      isTargetingDifferentHive,
      isUnresolvedTarget,
      isResolvingTarget: Boolean(hasProvider && loading && hives.length === 0),
      targetQueryHiveId,
      exitTargetHref,
      withTargetHiveId: (path: string) => appendTargetHiveId(path, targetQueryHiveId),
      confirmCrossHiveWrite: (action: string) => {
        if (!isTargetingDifferentHive || !targetHive || !activeHive) return true;
        return window.confirm(
          `${action} will update ${targetHive.name}, not your active hive ${activeHive.name}. Continue?`,
        );
      },
    };
  }, [activeHive, hasProvider, hives, loading, pathname, routeId]);
}

export function TargetHiveBanner({
  activeHive,
  targetHive,
  exitHref,
}: {
  activeHive: Hive | null;
  targetHive: Hive | null;
  exitHref: string;
}) {
  if (!activeHive || !targetHive || activeHive.id === targetHive.id) return null;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-100/80 p-4 text-sm text-amber-950 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-50">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>
          Target mode: viewing <span className="font-semibold">{targetHive.name}</span> while your sidebar active hive is{" "}
          <span className="font-semibold">{activeHive.name}</span>.
        </p>
        <Link href={exitHref} className="w-fit rounded-md border border-amber-400/50 px-3 py-1.5 font-medium hover:bg-amber-200/70 dark:hover:bg-amber-400/20">
          Return to active hive
        </Link>
      </div>
    </div>
  );
}

export function UnresolvedHiveTargetMessage({ hiveId }: { hiveId: string | null | undefined }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
      Hive target {hiveId ? <span className="font-mono">{hiveId}</span> : "requested"} was not found. No active-hive fallback was used.
    </div>
  );
}
