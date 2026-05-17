import { DeliverableCard } from "./deliverable-card";
import type { DeliverableSummary } from "@/deliverables/types";

export function GoalDeliverablesPanel({ deliverables }: { deliverables: DeliverableSummary[] }) {
  if (deliverables.length === 0) return null;

  const needsReview = deliverables.filter((deliverable) => deliverable.reviewStatus === "needs_review");

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Task artifacts / audit trail</h2>
        <p className="text-sm text-zinc-500">
          These are intermediate task outputs used as evidence. The final owner output appears in Final outputs when the goal is completed.
        </p>
      </div>

      {needsReview.length > 0 && (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">Audit artifacts needing review</h3>
          <div className="grid gap-4 md:grid-cols-2">
            {needsReview.map((deliverable) => (
              <DeliverableCard key={deliverable.id} deliverable={deliverable} />
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {deliverables.map((deliverable) => (
          <DeliverableCard key={deliverable.id} deliverable={deliverable} />
        ))}
      </div>
    </section>
  );
}
