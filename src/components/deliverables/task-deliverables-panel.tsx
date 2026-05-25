import { DeliverableCard } from "./deliverable-card";
import type { DeliverableSummary } from "@/deliverables/types";

export function TaskDeliverablesPanel({ deliverables }: { deliverables: DeliverableSummary[] }) {
  if (deliverables.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">Task artifacts</h2>
          <p className="mt-1 text-xs text-zinc-500">Raw task outputs kept for audit/debugging; final owner outcomes live in Final outputs.</p>
        </div>
        <span className="text-xs text-zinc-500">{deliverables.length} artifact{deliverables.length === 1 ? "" : "s"}</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {deliverables.map((deliverable) => (
          <DeliverableCard key={deliverable.id} deliverable={deliverable} />
        ))}
      </div>
    </section>
  );
}
