"use client";

import { useHiveContext } from "@/components/hive-context";
import { MobileSupervisionSurface } from "@/components/mobile-supervision-surface";

export default function SupervisionPage() {
  const { selected, loading } = useHiveContext();

  if (loading) return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (!selected) {
    return (
      <div className="rounded-[12px] border border-dashed border-honey-700/40 bg-card/60 p-8 text-center text-[13px] text-muted-foreground">
        No hive selected. Choose a hive to open mobile supervision.
      </div>
    );
  }

  return <MobileSupervisionSurface hiveId={selected.id} hiveName={selected.name} />;
}
