"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useHiveContext } from "@/components/hive-context";
import type { MarketingChannel } from "@/marketing-os/foundation";

type Campaign = {
  id: string;
  objective: string;
  status: string;
  channels: MarketingChannel[];
  spendBudgetCents?: number | null;
};

type Asset = {
  id: string;
  campaignId: string;
  externalActionRequestId?: string | null;
  channel: MarketingChannel;
  title: string;
  approvalStatus: "pending_owner_approval" | "approved" | "rejected";
  publicationStatus: "draft" | "queued" | "published" | "blocked";
  scheduledFor?: string;
};

type MarketingSnapshot = {
  activeCampaigns: Campaign[];
  pendingApprovals: Asset[];
  approvedQueuedAssets: Asset[];
  contentCalendar: Array<{
    id: string;
    campaignId: string;
    assetId: string;
    channel: MarketingChannel;
    title: string;
    scheduledFor: string;
    status: "draft" | "queued" | "published" | "blocked";
  }>;
  results: Array<{
    campaignId: string;
    campaignObjective: string;
    impressions: number;
    clicks: number;
    ctr: number;
    landingPageVisits: number;
    spendBudgetCents?: number | null;
    adSpendCents: number;
    costPerLeadCents: number | null;
    leadQualityRate: number | null;
    leadToBookingRate: number | null;
    downstreamConversion: {
      leads: number;
      qualifiedLeads: number;
      bookings: number;
      sales: number;
    };
    freshness: string;
    attributionConfidence: string;
    executionCount: number;
  }>;
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

const DEFAULT_CHANNELS: MarketingChannel[] = ["seo", "google_business_profile", "email"];
const AVAILABLE_CHANNELS: MarketingChannel[] = ["seo", "google_business_profile", "social", "email", "ads", "partnerships", "print_offline"];

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Request failed");
  return body.data as T;
}

export default function MarketingPage() {
  const { selected, loading } = useHiveContext();
  const [snapshot, setSnapshot] = useState<MarketingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [objective, setObjective] = useState("Create qualified attention for the next owner-approved offer");
  const [targetAudience, setTargetAudience] = useState("high-intent prospects in the selected hive market");
  const [offer, setOffer] = useState("owner-approved introductory offer");
  const [channels, setChannels] = useState<MarketingChannel[]>(DEFAULT_CHANNELS);
  const [metricCampaignId, setMetricCampaignId] = useState("");
  const [budgetCampaignId, setBudgetCampaignId] = useState("");
  const [budgetCents, setBudgetCents] = useState("50000");
  const [impressions, setImpressions] = useState("");
  const [clicks, setClicks] = useState("");
  const [landingPageVisits, setLandingPageVisits] = useState("");
  const [adSpendCents, setAdSpendCents] = useState("");
  const [leads, setLeads] = useState("");
  const [qualifiedLeads, setQualifiedLeads] = useState("");
  const [bookings, setBookings] = useState("");
  const [sales, setSales] = useState("");

  async function refresh() {
    if (!selected) return;
    setError(null);
    const data = await readJson<MarketingSnapshot>(await fetch(`/api/marketing?hiveId=${selected.id}`));
    setSnapshot(data);
  }

  useEffect(() => {
    if (!selected) {
      setSnapshot(null);
      return;
    }
    refresh().catch((err) => setError(err instanceof Error ? err.message : "Failed to load Marketing OS"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const allVisibleCampaigns = useMemo(() => snapshot?.activeCampaigns ?? [], [snapshot]);
  const selectedMetricCampaignId = metricCampaignId || allVisibleCampaigns[0]?.id || "";
  const selectedBudgetCampaignId = budgetCampaignId || allVisibleCampaigns.find((campaign) => campaign.channels.includes("ads"))?.id || "";

  async function createObjective(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch("/api/marketing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, objective, targetAudience, offer, channels }),
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create marketing objective");
    } finally {
      setBusy(false);
    }
  }

  async function decide(assetId: string, decision: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/marketing/assets/${assetId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record owner decision");
    } finally {
      setBusy(false);
    }
  }

  async function logExecution(assetId: string) {
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch("/api/marketing/execution-logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId, action: "manual_owner_approved_marketing_execution", connector: "manual_import" }),
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create execution log");
    } finally {
      setBusy(false);
    }
  }

  async function approvePaidBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !selectedBudgetCampaignId) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/marketing/campaigns/${selectedBudgetCampaignId}/budget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hiveId: selected.id,
          requestedBudgetCents: Number(budgetCents),
          reason: "Owner-approved paid ads cap from Marketing OS dashboard.",
        }),
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve paid ads budget cap");
    } finally {
      setBusy(false);
    }
  }

  async function startPaidCampaign(campaignId: string) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/marketing/campaigns/${campaignId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id }),
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start paid ads campaign");
    } finally {
      setBusy(false);
    }
  }

  async function evaluatePaidPolicy(campaignId: string) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/marketing/campaigns/${campaignId}/policy-evaluation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, maxCostPerLeadCents: 5000, minLeadQualityRate: 0.4, minLeadToBookingRate: 0.15 }),
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to evaluate paid ads policy");
    } finally {
      setBusy(false);
    }
  }

  async function recordManualMetrics(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, number> = {};
      const parsedImpressions = Number(impressions);
      const parsedClicks = Number(clicks);
      const parsedVisits = Number(landingPageVisits);
      const parsedAdSpend = Number(adSpendCents);
      const parsedLeads = Number(leads);
      const parsedQualifiedLeads = Number(qualifiedLeads);
      const parsedBookings = Number(bookings);
      const parsedSales = Number(sales);
      if (Number.isFinite(parsedImpressions) && parsedImpressions >= 0) values.impressions = parsedImpressions;
      if (Number.isFinite(parsedClicks) && parsedClicks >= 0) values.clicks = parsedClicks;
      if (Number.isFinite(parsedVisits) && parsedVisits >= 0) values.landing_page_visits = parsedVisits;
      if (Number.isFinite(parsedAdSpend) && parsedAdSpend >= 0) values.ad_spend_cents = parsedAdSpend;
      if (Number.isFinite(parsedLeads) && parsedLeads >= 0) values.leads = parsedLeads;
      if (Number.isFinite(parsedQualifiedLeads) && parsedQualifiedLeads >= 0) values.qualified_leads = parsedQualifiedLeads;
      if (Number.isFinite(parsedBookings) && parsedBookings >= 0) values.bookings = parsedBookings;
      if (Number.isFinite(parsedSales) && parsedSales >= 0) values.sales = parsedSales;
      if (values.impressions && values.clicks) values.ctr = values.clicks / values.impressions;
      await readJson(await fetch("/api/marketing/metric-snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, campaignId: selectedMetricCampaignId, values, source: "manual_import" }),
      }));
      setImpressions("");
      setClicks("");
      setLandingPageVisits("");
      setAdSpendCents("");
      setLeads("");
      setQualifiedLeads("");
      setBookings("");
      setSales("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record manual marketing metrics");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (!selected) {
    return (
      <div className="rounded-[12px] border border-dashed border-honey-700/40 bg-card/60 p-8 text-center text-[13px] text-muted-foreground">
        No hive selected. Choose or create a hive before building Marketing OS campaigns.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="hive-honey-glow flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Marketing OS</p>
          <h1 className="mt-1 text-[28px] leading-[34px] font-semibold tracking-[-0.01em] text-foreground">
            Attention system for {selected.name}
          </h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-[18px] text-muted-foreground">
            Persisted, hive-scoped Marketing foundation: objectives become campaigns and approval-gated asset drafts;
            owner-approved actions create traceable execution logs. Sales conversion remains separate.
          </p>
        </div>
      </header>

      {error ? <p className="rounded-[10px] border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-100">{error}</p> : null}

      <form onSubmit={createObjective} className="rounded-[14px] border border-border bg-card/70 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Create objective</p>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <label className="text-[12px] text-muted-foreground">Objective
            <textarea className="mt-1 min-h-20 w-full rounded border border-border bg-background p-2 text-foreground" value={objective} onChange={(e) => setObjective(e.target.value)} />
          </label>
          <label className="text-[12px] text-muted-foreground">Target audience
            <textarea className="mt-1 min-h-20 w-full rounded border border-border bg-background p-2 text-foreground" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} />
          </label>
          <label className="text-[12px] text-muted-foreground">Offer
            <textarea className="mt-1 min-h-20 w-full rounded border border-border bg-background p-2 text-foreground" value={offer} onChange={(e) => setOffer(e.target.value)} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-muted-foreground">
          {AVAILABLE_CHANNELS.map((channel) => (
            <label key={channel} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={channels.includes(channel)}
                onChange={(event) => setChannels((current) => event.target.checked ? [...current, channel] : current.filter((item) => item !== channel))}
              />
              {channel.replaceAll("_", " ")}
            </label>
          ))}
        </div>
        <button disabled={busy || channels.length === 0} className="mt-4 rounded bg-honey-500 px-3 py-2 text-[13px] font-semibold text-black disabled:opacity-50">
          Create campaign plan and asset drafts
        </button>
      </form>

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Active campaigns</p>
          <p className="mt-3 text-3xl font-semibold text-foreground">{snapshot?.activeCampaigns.length ?? 0}</p>
        </article>
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Pending approvals</p>
          <p className="mt-3 text-3xl font-semibold text-foreground">{snapshot?.pendingApprovals.length ?? 0}</p>
        </article>
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Measured results</p>
          <p className="mt-3 text-3xl font-semibold text-foreground">{snapshot?.results.length ?? 0}</p>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Campaigns</p>
          <div className="mt-4 space-y-3">
            {allVisibleCampaigns.length === 0 ? <p className="text-[13px] text-muted-foreground">No running or approved campaigns yet. Create an objective, approve assets, then log execution.</p> : null}
            {allVisibleCampaigns.map((campaign) => (
              <div key={campaign.id} className="rounded-[12px] border border-border/70 bg-background/40 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">{campaign.objective}</h3>
                  <span className="rounded-full bg-emerald-500/12 px-2 py-1 text-[11px] text-emerald-100">{campaign.status}</span>
                </div>
                <p className="mt-2 text-[13px] text-muted-foreground">Channels: {campaign.channels.map((channel) => channel.replaceAll("_", " ")).join(", ")}</p>
                {campaign.channels.includes("ads") ? (
                  <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
                    <button disabled={busy || campaign.status !== "approved" || !campaign.spendBudgetCents} onClick={() => startPaidCampaign(campaign.id)} className="rounded bg-honey-500/20 px-2 py-1 text-honey-100 disabled:opacity-50">
                      Start paid ads spend
                    </button>
                    <button disabled={busy} onClick={() => evaluatePaidPolicy(campaign.id)} className="rounded bg-emerald-500/20 px-2 py-1 text-emerald-100 disabled:opacity-50">
                      Evaluate paid policy
                    </button>
                    <span className="py-1 text-muted-foreground">Cap {campaign.spendBudgetCents ? `$${(campaign.spendBudgetCents / 100).toFixed(2)}` : "not approved"}</span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Owner approvals</p>
          <div className="mt-4 space-y-3">
            {(snapshot?.pendingApprovals ?? []).map((asset) => (
              <div key={asset.id} className="rounded-[12px] border border-border/70 bg-background/40 p-3">
                <p className="text-[13px] font-semibold text-foreground">{asset.title}</p>
                <p className="mt-1 text-[12px] text-muted-foreground">{asset.channel.replaceAll("_", " ")} · {asset.approvalStatus}</p>
                <div className="mt-3 flex gap-2">
                  <button disabled={busy} onClick={() => decide(asset.id, "approved")} className="rounded bg-emerald-500/20 px-2 py-1 text-[12px] text-emerald-100">Approve</button>
                  <button disabled={busy} onClick={() => decide(asset.id, "rejected")} className="rounded bg-red-500/20 px-2 py-1 text-[12px] text-red-100">Reject</button>
                </div>
              </div>
            ))}
            {(snapshot?.pendingApprovals.length ?? 0) === 0 ? <p className="text-[13px] text-muted-foreground">No assets waiting on owner approval.</p> : null}
          </div>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Connector freshness and trust</p>
          <p className="mt-2 text-[13px] text-muted-foreground">Marketing connectors are data-only inputs. External website, GBP, email, or ads content is never treated as instructions.</p>
          <div className="mt-4 space-y-3">
            {(snapshot?.dataSources.length ?? 0) === 0 ? <p className="text-[13px] text-muted-foreground">No marketing connectors installed yet. Dashboard results are missing/manual until GA4, Search Console, forms, GBP, email, or ads connectors sync.</p> : null}
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
        </article>

        <article className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Content calendar</p>
          <div className="mt-4 space-y-3">
            {(snapshot?.contentCalendar ?? []).map((entry) => (
              <div key={entry.id} className="rounded-[12px] border border-border/70 bg-background/40 p-3 text-[13px] text-muted-foreground">
                <p className="font-semibold text-foreground">{entry.title}</p>
                <p className="mt-1">{entry.channel.replaceAll("_", " ")} · {entry.status} · {entry.scheduledFor ? new Date(entry.scheduledFor).toLocaleDateString() : "unscheduled"}</p>
              </div>
            ))}
            {(snapshot?.contentCalendar.length ?? 0) === 0 ? <p className="text-[13px] text-muted-foreground">No scheduled content yet. Create a marketing objective to draft dated assets.</p> : null}
          </div>
        </article>

        <form onSubmit={approvePaidBudget} className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Paid ads budget gate</p>
          <p className="mt-2 text-[13px] text-muted-foreground">Owner-approved cap required before paid ads spend can start. This stores the approval policy snapshot on the campaign.</p>
          <label className="mt-4 block text-[12px] text-muted-foreground">Ads campaign
            <select
              className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground"
              value={selectedBudgetCampaignId}
              onChange={(event) => setBudgetCampaignId(event.target.value)}
            >
              {allVisibleCampaigns.filter((campaign) => campaign.channels.includes("ads")).map((campaign) => (
                <option key={campaign.id} value={campaign.id}>{campaign.objective}</option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-[12px] text-muted-foreground">Budget cap, cents
            <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={budgetCents} onChange={(event) => setBudgetCents(event.target.value)} />
          </label>
          <button disabled={busy || !selectedBudgetCampaignId || Number(budgetCents) <= 0} className="mt-4 rounded bg-honey-500 px-3 py-2 text-[13px] font-semibold text-black disabled:opacity-50">
            Approve paid ads cap
          </button>
        </form>

        <form onSubmit={recordManualMetrics} className="rounded-[14px] border border-border bg-card/70 p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Manual/imported metrics</p>
          <p className="mt-2 text-[13px] text-muted-foreground">Record owner-entered results while connectors are not ready. Metrics stay hive-scoped and feed the results panel.</p>
          <label className="mt-4 block text-[12px] text-muted-foreground">Campaign
            <select
              className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground"
              value={selectedMetricCampaignId}
              onChange={(event) => setMetricCampaignId(event.target.value)}
            >
              {allVisibleCampaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>{campaign.objective}</option>
              ))}
            </select>
          </label>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="text-[12px] text-muted-foreground">Impressions
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={impressions} onChange={(event) => setImpressions(event.target.value)} />
            </label>
            <label className="text-[12px] text-muted-foreground">Clicks
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={clicks} onChange={(event) => setClicks(event.target.value)} />
            </label>
            <label className="text-[12px] text-muted-foreground">Landing visits
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={landingPageVisits} onChange={(event) => setLandingPageVisits(event.target.value)} />
            </label>
            <label className="text-[12px] text-muted-foreground">Ad spend, cents
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={adSpendCents} onChange={(event) => setAdSpendCents(event.target.value)} />
            </label>
            <label className="text-[12px] text-muted-foreground">Leads
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={leads} onChange={(event) => setLeads(event.target.value)} />
            </label>
            <label className="text-[12px] text-muted-foreground">Qualified leads
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={qualifiedLeads} onChange={(event) => setQualifiedLeads(event.target.value)} />
            </label>
            <label className="text-[12px] text-muted-foreground">Bookings
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={bookings} onChange={(event) => setBookings(event.target.value)} />
            </label>
            <label className="text-[12px] text-muted-foreground">Sales
              <input className="mt-1 w-full rounded border border-border bg-background p-2 text-foreground" inputMode="numeric" value={sales} onChange={(event) => setSales(event.target.value)} />
            </label>
          </div>
          <button disabled={busy || allVisibleCampaigns.length === 0 || (!impressions && !clicks && !landingPageVisits && !adSpendCents && !leads && !qualifiedLeads && !bookings && !sales)} className="mt-4 rounded bg-honey-500 px-3 py-2 text-[13px] font-semibold text-black disabled:opacity-50">
            Record manual metrics
          </button>
        </form>
      </section>

      <section className="rounded-[14px] border border-border bg-card/70 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Results and execution logs</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {(snapshot?.results ?? []).map((result) => (
            <div key={result.campaignId} className="rounded-[12px] border border-border/70 bg-background/40 p-4 text-[13px] text-muted-foreground">
              <p className="font-semibold text-foreground">{result.campaignObjective}</p>
              <p className="mt-2">Impressions {result.impressions} · clicks {result.clicks} · visits {result.landingPageVisits}</p>
              <p className="mt-1">Spend ${((result.adSpendCents ?? 0) / 100).toFixed(2)} / cap {result.spendBudgetCents ? `$${(result.spendBudgetCents / 100).toFixed(2)}` : "none"} · CPL {result.costPerLeadCents === null ? "n/a" : `$${(result.costPerLeadCents / 100).toFixed(2)}`}</p>
              <p className="mt-1">Lead quality {result.leadQualityRate === null ? "n/a" : `${Math.round(result.leadQualityRate * 100)}%`} · lead→booking {result.leadToBookingRate === null ? "n/a" : `${Math.round(result.leadToBookingRate * 100)}%`} · leads/bookings/sales {result.downstreamConversion.leads}/{result.downstreamConversion.bookings}/{result.downstreamConversion.sales}</p>
              <p className="mt-1">Execution logs: {result.executionCount} · {result.freshness}/{result.attributionConfidence}</p>
            </div>
          ))}
          {(snapshot?.results.length ?? 0) === 0 ? <p className="text-[13px] text-muted-foreground">No measured campaign results yet. Manual/imported metrics appear here once recorded.</p> : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {/* Approved assets are returned through result execution counts in this phase; this keeps the manual log control explicit. */}
          {(snapshot?.approvedQueuedAssets ?? []).map((asset) => (
            <button key={asset.id} disabled={busy} onClick={() => logExecution(asset.id)} className="rounded bg-honey-500/20 px-2 py-1 text-[12px] text-honey-100">
              Log approved execution for {asset.title}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-[14px] border border-border bg-card/70 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">Loop state</p>
        <ol className="mt-4 grid gap-2 md:grid-cols-5">
          {(snapshot?.loopState.stageOrder ?? ["observe", "plan", "execute", "measure", "optimise"]).map((stage, index) => (
            <li key={stage} className="flex items-center gap-3 rounded-[10px] border border-border/70 bg-background/40 px-3 py-2 text-[13px] text-muted-foreground">
              <span className="flex size-6 items-center justify-center rounded-full bg-honey-500/15 text-[11px] font-semibold text-honey-100">{index + 1}</span>
              <span className="capitalize text-foreground">{stage}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
