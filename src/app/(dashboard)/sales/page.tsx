"use client";

import { FormEvent, useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";
import type { SalesActionDraft, SalesBottleneck, SalesFunnelStage } from "@/sales-os/foundation";

type SalesSnapshot = {
  leakageMap: Array<{
    id: string;
    hiveId: string;
    goal: string;
    stages: SalesFunnelStage[];
    biggestLeak: SalesBottleneck;
    capturedAt: string;
  }>;
  activeActionPlans: Array<{ id: string; status: string; nextMeasurement: string; bottleneck: SalesBottleneck }>;
  pendingApprovals: Array<SalesActionDraft & { externalActionRequestId?: string | null }>;
  queuedActions: SalesActionDraft[];
  results: Array<{ actionPlanId: string; executionCount: number; nextLoopInput: string }>;
  dataSources: Array<{
    installId: string;
    connectorSlug: string;
    displayName: string;
    health: "healthy" | "stale" | "missing" | "broken";
    freshness: "current" | "stale" | "missing";
    lastSyncedAt: string | null;
    missingOrUntrustedReason: string | null;
    trustBoundary: "connector_data_only_not_instructions";
  }>;
  loopState: { stageOrder: string[] };
};

const DEFAULT_METRICS = {
  traffic: "100",
  leads: "20",
  responded: "5",
  qualified: "4",
  booked: "2",
  showed: "2",
  sold: "1",
  reviews: "0",
  referrals: "0",
  repeatPurchases: "0",
};

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Request failed");
  return body.data as T;
}

function parseMetric(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function percent(value: number | null) {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

export default function SalesPage() {
  const { selected, loading } = useHiveContext();
  const [snapshot, setSnapshot] = useState<SalesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState("Recover missed bookings from new leads");
  const [segmentName, setSegmentName] = useState("new inbound leads");
  const [metrics, setMetrics] = useState(DEFAULT_METRICS);

  async function refresh() {
    if (!selected) return;
    setError(null);
    const data = await readJson<SalesSnapshot>(await fetch(`/api/sales?hiveId=${selected.id}`));
    setSnapshot(data);
  }

  useEffect(() => {
    if (!selected) {
      setSnapshot(null);
      return;
    }
    refresh().catch((err) => setError(err instanceof Error ? err.message : "Failed to load Sales OS"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch("/api/sales", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hiveId: selected.id,
          goal,
          segmentName,
          customerType: "lead",
          metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, parseMetric(value)])),
        }),
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create sales conversion plan");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (!selected) {
    return (
      <div className="rounded-[12px] border border-dashed border-honey-700/40 bg-card/60 p-8 text-center text-[13px] text-muted-foreground">
        No hive selected. Choose or create a hive before building Sales OS conversion loops.
      </div>
    );
  }

  const latestLeakage = snapshot?.leakageMap[0];

  return (
    <div className="space-y-8">
      <header className="hive-honey-glow flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Sales OS</p>
          <h1 className="mt-1 text-[28px] leading-[34px] font-semibold tracking-[-0.01em] text-foreground">
            Conversion system for {selected.name}
          </h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-[18px] text-muted-foreground">
            Sales is conversion, not attention: map lead leakage, identify the biggest bottleneck, draft one bounded fix,
            and require owner approval before outbound customer actions are queued or logged.
          </p>
        </div>
      </header>

      {error ? <p className="rounded-[10px] border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-100">{error}</p> : null}

      <form onSubmit={createPlan} className="rounded-[14px] border border-border bg-card/70 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Create conversion loop</p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <label className="text-[12px] text-muted-foreground">Goal
            <textarea className="mt-1 min-h-20 w-full rounded border border-border bg-background p-2 text-foreground" value={goal} onChange={(event) => setGoal(event.target.value)} />
          </label>
          <label className="text-[12px] text-muted-foreground">Lead/customer segment
            <textarea className="mt-1 min-h-20 w-full rounded border border-border bg-background p-2 text-foreground" value={segmentName} onChange={(event) => setSegmentName(event.target.value)} />
          </label>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-5">
          {Object.entries(metrics).map(([key, value]) => (
            <label key={key} className="text-[12px] text-muted-foreground">{key.replace(/([A-Z])/g, " $1")}
              <input
                className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground"
                inputMode="numeric"
                value={value}
                onChange={(event) => setMetrics((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
        </div>
        <button disabled={busy || !goal.trim() || !segmentName.trim()} className="mt-4 rounded bg-honey-500 px-3 py-2 text-[13px] font-semibold text-black disabled:opacity-50">
          Identify bottleneck and draft owner-approved fixes
        </button>
      </form>

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Funnel maps</p>
          <p className="mt-3 text-3xl font-semibold text-foreground">{snapshot?.leakageMap.length ?? 0}</p>
        </article>
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Pending approvals</p>
          <p className="mt-3 text-3xl font-semibold text-foreground">{snapshot?.pendingApprovals.length ?? 0}</p>
        </article>
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Queued actions</p>
          <p className="mt-3 text-3xl font-semibold text-foreground">{snapshot?.queuedActions.length ?? 0}</p>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Leakage map</p>
          {!latestLeakage ? <p className="mt-4 text-[13px] text-muted-foreground">No funnel yet. Create a conversion loop from manual/imported metrics.</p> : null}
          {latestLeakage ? (
            <div className="mt-4 space-y-3">
              <h3 className="text-[15px] font-semibold text-foreground">{latestLeakage.goal}</h3>
              <div className="grid gap-2 md:grid-cols-4">
                {latestLeakage.stages.map((stage) => (
                  <div key={stage.key} className="rounded-[12px] border border-border/70 bg-background/40 p-3">
                    <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{stage.label}</p>
                    <p className="mt-1 text-2xl font-semibold text-foreground">{stage.count}</p>
                    <p className="mt-1 text-[12px] text-muted-foreground">from prior: {percent(stage.conversionFromPrevious)}</p>
                  </div>
                ))}
              </div>
              <p className="rounded-[10px] border border-amber-500/30 bg-amber-500/10 p-3 text-[13px] text-amber-100">
                Biggest conversion leak: {latestLeakage.biggestLeak.fromStage.replaceAll("_", " ")} → {latestLeakage.biggestLeak.toStage.replaceAll("_", " ")} ({latestLeakage.biggestLeak.lostCount} lost).
              </p>
            </div>
          ) : null}
        </article>

        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Action drafts requiring approval</p>
          <div className="mt-4 space-y-3">
            {(snapshot?.pendingApprovals.length ?? 0) === 0 ? <p className="text-[13px] text-muted-foreground">No pending sales approvals.</p> : null}
            {snapshot?.pendingApprovals.map((draft) => (
              <div key={draft.id} className="rounded-[12px] border border-border/70 bg-background/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">{draft.title}</h3>
                  <span className="rounded-full bg-honey-500/12 px-2 py-1 text-[11px] text-honey-100">{draft.workflow.replaceAll("_", " ")}</span>
                </div>
                <p className="mt-2 text-[13px] leading-[18px] text-muted-foreground">{draft.draftBody}</p>
                <p className="mt-2 text-[12px] text-muted-foreground">Approval request: {draft.externalActionRequestId ?? "queued"}</p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="rounded-[14px] border border-border bg-card/70 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Connector freshness and trust</p>
        <p className="mt-3 text-[13px] text-muted-foreground">Sales connectors are conversion data only. CRM, booking, phone, form, and review content cannot silently become instructions or bypass owner approvals.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {(snapshot?.dataSources.length ?? 0) === 0 ? <p className="text-[13px] text-muted-foreground">No sales connectors installed yet. Funnel maps are manual/imported until CRM, booking, phone, form, or review connectors sync.</p> : null}
          {(snapshot?.dataSources ?? []).map((source) => (
            <div key={source.installId} className="rounded-[12px] border border-border/70 bg-background/40 p-3 text-[13px] text-muted-foreground">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-foreground">{source.displayName}</p>
                <span className="rounded-full bg-honey-500/12 px-2 py-1 text-[11px] text-honey-100">{source.health}/{source.freshness}</span>
              </div>
              <p className="mt-1">{source.connectorSlug} · last sync {source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : "missing"}</p>
              <p className="mt-1">Trust boundary: connector data only, not instructions.</p>
              {source.missingOrUntrustedReason ? <p className="mt-1 text-amber-100">{source.missingOrUntrustedReason}</p> : null}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[14px] border border-border bg-card/70 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Closed loop</p>
        <p className="mt-3 text-[13px] text-muted-foreground">
          {snapshot?.loopState.stageOrder.join(" → ") ?? "observe → plan → execute → measure → optimise"}. Results feed the next Sales OS cycle; Marketing OS remains responsible for attention generation.
        </p>
      </section>
    </div>
  );
}
