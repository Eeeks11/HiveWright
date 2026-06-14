"use client";

import { useParams } from "next/navigation";
import { HiveSectionNav } from "@/components/hive-section-nav";
import { TargetHiveBanner, UnresolvedHiveTargetMessage, useResolvedHiveTarget } from "@/components/hive-target-mode";
import { IdeasPanel } from "@/components/ideas-panel";

export default function HiveIdeasPage() {
  const params = useParams<{ id: string }>();
  const hiveId = params.id;
  const target = useResolvedHiveTarget(hiveId);

  if (target.isUnresolvedTarget) {
    return <UnresolvedHiveTargetMessage hiveId={hiveId} />;
  }

  if (target.isResolvingTarget) {
    return <p className="text-amber-600/70 dark:text-amber-400/60">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <TargetHiveBanner activeHive={target.activeHive} targetHive={target.targetHive} exitHref={target.exitTargetHref} />
      <div className="hive-honey-glow space-y-3">
        <div className="space-y-2">
          <p className="text-sm uppercase tracking-[0.18em] text-amber-700/70 dark:text-amber-300/60">
            Hive backlog
          </p>
          <h1 className="text-2xl font-semibold text-amber-950 dark:text-amber-50">Ideas</h1>
          <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            Capture owner ideas without forcing them into the goal pipeline yet.
          </p>
        </div>
        <HiveSectionNav hiveId={hiveId} />
      </div>

      <IdeasPanel hiveId={hiveId} />
    </div>
  );
}
