"use client";
import { useEffect, useState, useCallback } from "react";
import type { FormEvent } from "react";
import { useParams } from "next/navigation";
import { HiveConnectorsPanel } from "@/components/hives/hive-connectors-panel";
import { HiveRecordsPanel } from "@/components/hives/hive-records-panel";
import { HiveScoreboard } from "@/components/hives/hive-scoreboard";
import { HiveSectionNav } from "@/components/hive-section-nav";
import { TargetHiveBanner, UnresolvedHiveTargetMessage, useResolvedHiveTarget } from "@/components/hive-target-mode";

interface OperatingProfile {
  kind: string;
  purpose: string;
  desiredOutcome: string;
  current30DayOutcome: string | null;
  constraints: string[];
  approvalRules: string[];
  forbiddenActions: string[];
  importantContext: string[];
  successCriteria: string[];
  stopOrPauseCriteria: string[];
  kindProfile: Record<string, unknown>;
  isDerived: boolean;
}

interface Hive {
  id: string;
  slug: string;
  name: string;
  type: string;
  kind: string;
  description: string | null;
  mission: string | null;
  softwareStack: string | null;
  workspacePath: string | null;
  aiBudget: {
    capCents: number;
    window: "daily" | "weekly" | "monthly" | "all_time";
  };
  operatingProfile: OperatingProfile | null;
  createdAt: string;
}

type BusinessOsOwnerDashboard = {
  status?: "setup_required";
  headline: string;
  summary: string | null;
  setupRequired?: {
    label: string;
    href: string;
    description?: string;
  };
  mode: "new_business" | "existing_business";
  stage: string | null;
  ownerGoals: string[];
  setupProgress: {
    label: string;
    completedSteps: number;
    totalSteps: number;
    percent: number;
    nextStep: string;
  };
  auditScorecard: {
    status: string;
    score: number | null;
    confidence: string | null;
    scope: string[];
    evidence: string[];
    knownUnknowns: string[];
  };
  operatingModelMap: {
    overallScore: number | null;
    nextReviewAt: string | null;
    modules: Array<{
      key: string;
      label: string;
      domain: string;
      href: string | null;
      score: number | null;
      maturity: string | null;
      confidence: string | null;
      summary: string | null;
      evidenceState: "measured" | "partial" | "missing";
      evidence: string[];
      gaps: string[];
      actions: string[];
      connectedSystems: string[];
      nextReviewAt: string | null;
    }>;
  };
  systemMaturity: {
    averageReadinessScore: number | null;
    readinessEvidenceState: "measured" | "unknown";
    readinessEvidenceMessage: string;
    atRiskSystems: string[];
    systems: Array<{
      key: string;
      label: string;
      score: number;
      maturity: string | null;
      confidence: string | null;
      summary: string | null;
      evidence: string[];
    }>;
  };
  priorityActions: Array<{
    id?: string | null;
    title: string;
    brief: string;
    status: string;
    priority: number;
    riskLevel: string | null;
    approvalRequired: boolean;
    expectedOutcome: string | null;
    measurementMetric: string | null;
    evidence: string[];
    targetHref?: string | null;
    targetStateLabel?: string | null;
    targetDescription?: string | null;
  }>;
  approvalsRequired: Array<{
    id?: string | null;
    title: string;
    brief: string;
    status: string;
    priority: number;
    riskLevel: string | null;
    expectedOutcome: string | null;
    evidence: string[];
    targetHref?: string | null;
    targetStateLabel?: string | null;
    targetDescription?: string | null;
  }>;
  openGaps: Array<{
    title: string;
    severity: string | null;
    status: string;
    systemKey: string | null;
    confidence: string | null;
    evidence: string[];
  }>;
  agentActivity: Array<{
    title: string;
    summary: string | null;
    status: string;
    role: string | null;
    evidenceUrl: string | null;
    hasEvidence: boolean;
    updatedAt: string | null;
  }>;
  changedSinceLastReview: Array<{
    type: string;
    label: string;
    detail: string;
    changedAt: string | null;
  }>;
  governance: {
    aiSpendBudgetLabel: string;
  };
  ownerNextReviewChecklist: string[];
};

type TargetStatus = "open" | "achieved" | "abandoned";

interface Target {
  id: string;
  hiveId: string;
  title: string;
  targetValue: string | null;
  deadline: string | null;
  notes: string | null;
  sortOrder: number;
  status: TargetStatus;
}

export default function HiveDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const target = useResolvedHiveTarget(id);

  const [hive, setHive] = useState<Hive | null>(null);
  const [businessOsDashboard, setBusinessOsDashboard] = useState<BusinessOsOwnerDashboard | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [contextPreview, setContextPreview] = useState<string>("");
  const [showPreview, setShowPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [uploadSaveState, setUploadSaveState] = useState<"idle" | "uploading" | "uploaded" | "error">("idle");
  const [selectedReferenceFile, setSelectedReferenceFile] = useState<File | null>(null);
  const [changesSaveState, setChangesSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [referenceTitle, setReferenceTitle] = useState("");
  const [budgetSaveState, setBudgetSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [profileSaveState, setProfileSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [exportState, setExportState] = useState<"idle" | "exporting" | "exported" | "error">("idle");
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load hive + targets. Called on mount and after any mutation.
  const reload = useCallback(async () => {
    if (target.isResolvingTarget) return;
    if (target.isUnresolvedTarget || !target.effectiveHiveId) {
      setHive(null);
      setBusinessOsDashboard(null);
      setTargets([]);
      setLoadError("Hive target not found");
      return;
    }
    setLoadError(null);
    const readJson = async (res: Response) => {
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed with ${res.status}`);
      }
      return body;
    };

    try {
      const readOptionalBusinessOsDashboard = async () => {
        const res = await fetch(`/api/hives/${id}/business-os-dashboard`);
        if (res.status === 404) return null;
        return readJson(res);
      };
      const [hiveRes, targetsRes, businessOsRes] = await Promise.all([
        fetch(`/api/hives/${id}`).then(readJson),
        fetch(`/api/hives/${id}/targets`).then(readJson),
        readOptionalBusinessOsDashboard(),
      ]);
      setHive(hiveRes.data ?? null);
      setTargets(targetsRes.data || []);
      setBusinessOsDashboard(businessOsRes?.data ?? null);
    } catch (error) {
      setBusinessOsDashboard(null);
      setLoadError(error instanceof Error ? error.message : "Failed to load hive");
    }
  }, [id, target.effectiveHiveId, target.isResolvingTarget, target.isUnresolvedTarget]);

  useEffect(() => {
    reload();
  }, [reload]);

  const patchHive = async (patch: Partial<Pick<Hive, "name" | "description" | "mission">>) => {
    if (!target.confirmCrossHiveWrite("Saving hive profile changes")) return;
    const res = await fetch(`/api/hives/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) reload();
  };

  const linesFromForm = (form: FormData, key: string) => String(form.get(key) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const saveOperatingProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target.confirmCrossHiveWrite("Saving operating profile changes")) return;
    setProfileSaveState("saving");
    const form = new FormData(event.currentTarget);
    const res = await fetch(`/api/hives/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operatingProfile: {
          purpose: String(form.get("purpose") ?? ""),
          desiredOutcome: String(form.get("desiredOutcome") ?? ""),
          current30DayOutcome: String(form.get("current30DayOutcome") ?? ""),
          constraints: linesFromForm(form, "constraints"),
          approvalRules: linesFromForm(form, "approvalRules"),
          forbiddenActions: linesFromForm(form, "forbiddenActions"),
          importantContext: linesFromForm(form, "importantContext"),
          successCriteria: linesFromForm(form, "successCriteria"),
          stopOrPauseCriteria: linesFromForm(form, "stopOrPauseCriteria"),
        },
      }),
    });
    if (res.ok) {
      setProfileSaveState("saved");
      await reload();
      setTimeout(() => setProfileSaveState("idle"), 2000);
    } else {
      setProfileSaveState("error");
      setTimeout(() => setProfileSaveState("idle"), 4000);
    }
  };

  const saveBudget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hive) return;
    if (!target.confirmCrossHiveWrite("Saving budget changes")) return;
    const form = new FormData(event.currentTarget);
    const dollars = Number(form.get("aiBudgetDollars"));
    const window = String(form.get("aiBudgetWindow") ?? hive.aiBudget.window);

    if (!Number.isFinite(dollars) || dollars < 0) {
      setBudgetSaveState("error");
      setTimeout(() => setBudgetSaveState("idle"), 4000);
      return;
    }

    setBudgetSaveState("saving");
    const res = await fetch(`/api/hives/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aiBudget: {
          capCents: Math.round(dollars * 100),
          window,
        },
      }),
    });

    if (res.ok) {
      setBudgetSaveState("saved");
      await reload();
      setTimeout(() => setBudgetSaveState("idle"), 2000);
    } else {
      setBudgetSaveState("error");
      setTimeout(() => setBudgetSaveState("idle"), 4000);
    }
  };

  const addTarget = async () => {
    if (!target.confirmCrossHiveWrite("Adding a target")) return;
    await fetch(`/api/hives/${id}/targets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New target" }),
    });
    reload();
  };

  const updateTarget = async (targetId: string, patch: Record<string, unknown>) => {
    if (!target.confirmCrossHiveWrite("Updating a target")) return;
    await fetch(`/api/hives/${id}/targets/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    reload();
  };

  const deleteTarget = async (targetId: string) => {
    if (!target.confirmCrossHiveWrite("Deleting a target")) return;
    if (!confirm("Delete this target? Use 'Achieved' or 'Abandoned' status for lifecycle changes.")) return;
    await fetch(`/api/hives/${id}/targets/${targetId}`, { method: "DELETE" });
    reload();
  };

  const moveTarget = async (targetId: string, direction: "up" | "down") => {
    const open = targets.filter(t => t.status === "open");
    const idx = open.findIndex(t => t.id === targetId);
    if (idx < 0) return;
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= open.length) return;
    await Promise.all([
      updateTarget(targetId, { sort_order: open[swapWith].sortOrder }),
      updateTarget(open[swapWith].id, { sort_order: open[idx].sortOrder }),
    ]);
  };

  const loadPreview = async () => {
    const res = await fetch(`/api/hives/${id}/context-preview`);
    if (res.ok) {
      const body = await res.json();
      setContextPreview(body.data?.block ?? "");
    }
    setShowPreview(true);
  };

  const exportTemplate = async () => {
    if (!hive) return;
    setExportState("exporting");
    setExportMessage(null);
    try {
      const res = await fetch(`/api/hives/${id}/portability/export`);
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(body?.error ?? `Export failed with ${res.status}`);
      const pkg = body.data;
      const blob = new Blob([`${JSON.stringify(pkg, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${hive.slug || "hive"}-template.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportState("exported");
      setExportMessage("Template downloaded. Credentials and runtime history were omitted.");
      setTimeout(() => {
        setExportState("idle");
        setExportMessage(null);
      }, 4000);
    } catch (error) {
      setExportState("error");
      setExportMessage(error instanceof Error ? error.message : "Failed to export template");
    }
  };
  const uploadReferenceDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target.confirmCrossHiveWrite("Uploading a reference document")) return;
    if (!selectedReferenceFile) {
      setUploadSaveState("error");
      setTimeout(() => setUploadSaveState("idle"), 3000);
      return;
    }
    const form = new FormData();
    form.append("file", selectedReferenceFile);
    if (referenceTitle.trim()) form.append("title", referenceTitle.trim());
    setUploadSaveState("uploading");
    const res = await fetch(`/api/hives/${id}/files?category=reference-documents`, {
      method: "POST",
      body: form,
    });
    if (res.ok) {
      setUploadSaveState("uploaded");
      setSelectedReferenceFile(null);
      setReferenceTitle("");
      const input = event.currentTarget.querySelector<HTMLInputElement>("input[type='file']");
      if (input) input.value = "";
      setTimeout(() => setUploadSaveState("idle"), 2500);
    } else {
      setUploadSaveState("error");
      setTimeout(() => setUploadSaveState("idle"), 5000);
    }
  };


  if (target.isUnresolvedTarget) {
    return <UnresolvedHiveTargetMessage hiveId={id} />;
  }

  if (target.isResolvingTarget || !hive) {
    return (
      <p className={loadError ? "text-red-600 dark:text-red-400" : "text-amber-600/70 dark:text-amber-400/60"}>
        {loadError ?? "Loading…"}
      </p>
    );
  }

  const openTargets = targets.filter(t => t.status === "open");
  const historyTargets = targets.filter(t => t.status !== "open");

  const actionTargetAffordance = (action: {
    targetHref?: string | null;
    targetStateLabel?: string | null;
    targetDescription?: string | null;
  }) => {
    if (action.targetHref) {
      return (
        <a href={action.targetHref} className="mt-2 inline-block text-xs font-medium text-blue-700 hover:underline dark:text-blue-300">
          Open action target
        </a>
      );
    }
    return (
      <div className="mt-2 rounded-md border border-dashed border-zinc-200 p-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">{action.targetStateLabel ?? "Informational"}</span>
        {action.targetDescription ? <span> — {action.targetDescription}</span> : null}
      </div>
    );
  };

  const renderTarget = (t: Target, i: number, isOpen: boolean) => {
    const muted = t.status !== "open";
    const titlePrefix = t.status === "achieved" ? "✓ " : "";
    const titleClass = t.status === "abandoned" ? "line-through" : "";
    return (
      <div key={t.id} className={`space-y-3 rounded-md border p-4 ${muted ? "opacity-60" : ""}`}>
        <div className="flex items-center gap-2">
          {titlePrefix && <span className="text-sm text-green-600 dark:text-green-400">{titlePrefix}</span>}
          <input
            defaultValue={t.title}
            onBlur={e => updateTarget(t.id, { title: e.target.value })}
            className={`flex-1 rounded-md border px-3 py-2 text-sm dark:bg-zinc-800 ${titleClass}`}
            placeholder="Target title"
          />
          <select
            value={t.status}
            onChange={e => updateTarget(t.id, { status: e.target.value })}
            className="cursor-pointer rounded-md border px-2 py-2 text-sm dark:bg-zinc-800"
          >
            <option value="open">Open</option>
            <option value="achieved">Achieved</option>
            <option value="abandoned">Abandoned</option>
          </select>
          {isOpen && (
            <>
              <button
                onClick={() => moveTarget(t.id, "up")}
                disabled={i === 0}
                className="cursor-pointer rounded-md border px-2 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800"
                aria-label="Move up"
              >↑</button>
              <button
                onClick={() => moveTarget(t.id, "down")}
                disabled={i === openTargets.length - 1}
                className="cursor-pointer rounded-md border px-2 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800"
                aria-label="Move down"
              >↓</button>
            </>
          )}
          <button
            onClick={() => deleteTarget(t.id)}
            className="cursor-pointer rounded-md border px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            Delete
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <input
            defaultValue={t.targetValue ?? ""}
            onBlur={e => updateTarget(t.id, { target_value: e.target.value || null })}
            className="rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            placeholder="Target value (e.g. $50k/mo)"
          />
          <input
            type="date"
            defaultValue={t.deadline ? String(t.deadline).slice(0, 10) : ""}
            onBlur={e => updateTarget(t.id, { deadline: e.target.value || null })}
            className="rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          />
        </div>
        <textarea
          defaultValue={t.notes ?? ""}
          onBlur={e => updateTarget(t.id, { notes: e.target.value || null })}
          rows={2}
          className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
          placeholder="Notes"
        />
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <TargetHiveBanner activeHive={target.activeHive} targetHive={target.targetHive} exitHref={target.exitTargetHref} />
      <div className="hive-honey-glow space-y-2">
        <input
          value={hive.name}
          onChange={e => setHive({ ...hive, name: e.target.value })}
          onBlur={() => patchHive({ name: hive.name })}
          className="w-full rounded-md bg-transparent px-1 -mx-1 text-2xl font-semibold text-amber-900 outline-none focus:ring-2 focus:ring-amber-300 dark:text-amber-50 dark:focus:ring-amber-400/50"
        />
        <div className="flex flex-wrap gap-2 text-xs text-amber-700/70 dark:text-amber-600/70">
          <span className="rounded-full bg-amber-100/60 px-2 py-0.5 font-mono text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">{hive.slug}</span>
          <span className="rounded-full bg-amber-100/60 px-2 py-0.5 text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">{hive.type}</span>
          <span>created {new Date(hive.createdAt).toLocaleDateString()}</span>
        </div>
        <HiveSectionNav hiveId={id} />
      </div>

      <section className="space-y-4 rounded-lg border border-amber-200/70 bg-amber-50/40 p-6 dark:border-amber-900/40 dark:bg-amber-950/10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Hive portability</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Export this hive as a reusable template for another business. Credentials, decisions, runs, memory, and work products are deliberately left out.
            </p>
          </div>
          <button
            type="button"
            onClick={exportTemplate}
            disabled={exportState === "exporting"}
            className="cursor-pointer rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-wait disabled:opacity-50"
          >
            {exportState === "exporting" ? "Exporting…" : "Export Template"}
          </button>
        </div>
        {exportMessage && (
          <p className={`text-sm ${exportState === "error" ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-300"}`}>
            {exportMessage}
          </p>
        )}
      </section>

      <HiveScoreboard hiveId={id} hiveKind={hive.kind ?? "business"} />

      {businessOsDashboard && (
        <section className="space-y-5 rounded-lg border border-blue-200 bg-blue-50/40 p-6 dark:border-blue-900/40 dark:bg-blue-950/10">
          {businessOsDashboard.setupRequired ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Business OS setup</p>
                <h2 className="text-xl font-semibold text-blue-950 dark:text-blue-50">{businessOsDashboard.headline}</h2>
                {businessOsDashboard.summary && <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">{businessOsDashboard.summary}</p>}
                {businessOsDashboard.setupRequired.description && <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">{businessOsDashboard.setupRequired.description}</p>}
              </div>
              <a
                href={businessOsDashboard.setupRequired.href}
                className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800"
              >
                {businessOsDashboard.setupRequired.label}
              </a>
            </div>
          ) : (<>
          <div className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Business OS command view</p>
                <h2 className="text-xl font-semibold text-blue-950 dark:text-blue-50">{businessOsDashboard.headline}</h2>
              </div>
              <div className="rounded-full bg-white px-3 py-1 text-xs font-medium text-blue-800 shadow-sm dark:bg-blue-950 dark:text-blue-100">
                {businessOsDashboard.governance.aiSpendBudgetLabel}
              </div>
            </div>
            {businessOsDashboard.summary && (
              <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">{businessOsDashboard.summary}</p>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Setup progress</p>
              <p className="mt-2 text-2xl font-semibold text-blue-950 dark:text-blue-50">{businessOsDashboard.setupProgress.percent}%</p>
              <p className="text-xs text-zinc-500">{businessOsDashboard.setupProgress.completedSteps}/{businessOsDashboard.setupProgress.totalSteps} sections complete</p>
              <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">{businessOsDashboard.setupProgress.nextStep}</p>
            </div>
            <div className="rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Audit scorecard</p>
              <p className="mt-2 text-2xl font-semibold text-blue-950 dark:text-blue-50">{businessOsDashboard.auditScorecard.score ?? "—"}</p>
              <p className="text-xs text-zinc-500">{businessOsDashboard.auditScorecard.status.replaceAll("_", " ")} · {businessOsDashboard.auditScorecard.confidence ?? "unknown"} confidence</p>
              <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">Scope: {businessOsDashboard.auditScorecard.scope.length ? businessOsDashboard.auditScorecard.scope.join(", ") : "not recorded"}</p>
            </div>
            <div className="rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">System maturity</p>
              <p className="mt-2 text-2xl font-semibold text-blue-950 dark:text-blue-50">{businessOsDashboard.systemMaturity.averageReadinessScore ?? "—"}</p>
              <p className="text-xs text-zinc-500">average readiness</p>
              <p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
                {businessOsDashboard.systemMaturity.readinessEvidenceMessage}
              </p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium text-blue-950 dark:text-blue-50">Business Operating Model map</h3>
                  <p className="text-xs text-zinc-500">Ideal Business OS modules, evidence, gaps, actions, systems, and next review.</p>
                </div>
                <div className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-100">
                  Score {businessOsDashboard.operatingModelMap.overallScore ?? "—"}
                </div>
              </div>
              {businessOsDashboard.operatingModelMap.nextReviewAt && (
                <p className="text-xs text-zinc-500">Next review: {new Date(businessOsDashboard.operatingModelMap.nextReviewAt).toLocaleString()}</p>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                {businessOsDashboard.operatingModelMap.modules.map((module) => (
                  <div key={module.key} className="rounded-md border p-3 text-sm dark:border-zinc-800">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-zinc-900 dark:text-zinc-100">{module.label}</p>
                        <p className="text-xs text-zinc-500">{module.domain}</p>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${module.evidenceState === "measured" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-200" : module.evidenceState === "partial" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"}`}>
                        {module.evidenceState}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      Score {module.score ?? "—"} · {module.maturity ?? "unmeasured"}{module.confidence ? ` · ${module.confidence} confidence` : ""}
                    </p>
                    {module.summary && <p className="mt-1 text-zinc-600 dark:text-zinc-400">{module.summary}</p>}
                    {module.connectedSystems.length > 0 && <p className="mt-1 text-xs text-zinc-500">Systems: {module.connectedSystems.join(", ")}</p>}
                    {module.gaps.length > 0 && <p className="mt-1 text-xs text-red-600 dark:text-red-300">Gaps: {module.gaps.slice(0, 2).join("; ")}</p>}
                    {module.actions.length > 0 && <p className="mt-1 text-xs text-blue-700 dark:text-blue-300">Actions: {module.actions.slice(0, 2).join("; ")}</p>}
                    {module.href && <a href={module.href} className="mt-2 inline-block text-xs font-medium text-blue-700 hover:underline dark:text-blue-300">Open module</a>}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3 rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="font-medium text-blue-950 dark:text-blue-50">Approvals required</h3>
              {businessOsDashboard.approvalsRequired.length === 0 && <p className="text-sm text-zinc-500">No approval-required Business OS actions are waiting.</p>}
              {businessOsDashboard.approvalsRequired.map((action) => (
                <div key={action.title} className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-amber-950 dark:text-amber-100">{action.title}</p>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{action.status.replaceAll("_", " ")}</span>
                  </div>
                  <p className="mt-1 text-zinc-700 dark:text-zinc-300">{action.brief}</p>
                  {action.expectedOutcome && <p className="mt-1 text-xs text-zinc-500">Outcome: {action.expectedOutcome}</p>}
                  {actionTargetAffordance(action)}
                </div>
              ))}
            </div>

            <div className="space-y-3 rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="font-medium text-blue-950 dark:text-blue-50">Priority actions</h3>
              {businessOsDashboard.priorityActions.length === 0 && <p className="text-sm text-zinc-500">No active Business OS actions yet.</p>}
              {businessOsDashboard.priorityActions.map((action) => (
                <div key={action.title} className="rounded-md border p-3 text-sm dark:border-zinc-800">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{action.title}</p>
                    <span className="text-xs text-zinc-500">P{action.priority}</span>
                  </div>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-400">{action.brief}</p>
                  <p className="mt-1 text-xs text-zinc-500">{action.status.replaceAll("_", " ")} · {action.riskLevel ?? "unknown"} risk{action.approvalRequired ? " · owner approval" : ""}</p>
                  {actionTargetAffordance(action)}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="font-medium text-blue-950 dark:text-blue-50">Agent activity and evidence</h3>
              {businessOsDashboard.agentActivity.length === 0 && <p className="text-sm text-zinc-500">No recent agent activity is linked to this Business OS yet.</p>}
              {businessOsDashboard.agentActivity.map((activity) => (
                <div key={`${activity.title}-${activity.updatedAt ?? ""}`} className="rounded-md border p-3 text-sm dark:border-zinc-800">
                  <p className="font-medium">{activity.title}</p>
                  <p className="text-xs text-zinc-500">{activity.role ?? "agent"} · {activity.status.replaceAll("_", " ")}</p>
                  {activity.summary && <p className="mt-1 text-zinc-600 dark:text-zinc-400">{activity.summary}</p>}
                  {activity.evidenceUrl && <a href={activity.evidenceUrl} className="mt-1 inline-block text-xs text-blue-700 hover:underline dark:text-blue-300">Open evidence</a>}
                </div>
              ))}
            </div>

            <div className="space-y-3 rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
              <h3 className="font-medium text-blue-950 dark:text-blue-50">Changed since last review</h3>
              {businessOsDashboard.changedSinceLastReview.length === 0 && <p className="text-sm text-zinc-500">No recent Business OS changes found.</p>}
              {businessOsDashboard.changedSinceLastReview.map((change) => (
                <div key={`${change.type}-${change.label}-${change.changedAt ?? ""}`} className="rounded-md border p-3 text-sm dark:border-zinc-800">
                  <p className="font-medium">{change.label}</p>
                  <p className="text-zinc-600 dark:text-zinc-400">{change.detail}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <h3 className="font-medium text-blue-950 dark:text-blue-50">Owner next review checklist</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
              {businessOsDashboard.ownerNextReviewChecklist.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
          </>)}
        </section>
      )}

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Budget controls</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Hive-level overall cap for billable AI spend. Subscription/OAuth token usage is excluded from this budget.
          </p>
        </div>
        <form onSubmit={saveBudget} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Hive budget cap (USD)</span>
            <input
              name="aiBudgetDollars"
              type="number"
              min="0"
              step="1"
              defaultValue={Math.round((hive.aiBudget?.capCents ?? 0) / 100)}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-200">Time window</span>
            <select
              name="aiBudgetWindow"
              defaultValue={hive.aiBudget?.window ?? "all_time"}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="all_time">All time</option>
            </select>
          </label>
          <button
            disabled={budgetSaveState === "saving"}
            className="cursor-pointer rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-wait disabled:opacity-50"
          >
            {budgetSaveState === "saving" ? "Saving…" : "Save budget"}
          </button>
        </form>
        <div className="flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>Current cap: ${((hive.aiBudget?.capCents ?? 0) / 100).toFixed(2)}</span>
          <span>•</span>
          <span>Window: {(hive.aiBudget?.window ?? "all_time").replace("_", " ")}</span>
          {budgetSaveState === "saved" && <span className="text-green-600 dark:text-green-400">✓ Saved</span>}
          {budgetSaveState === "error" && <span className="text-red-600 dark:text-red-400">Save failed</span>}
        </div>
      </section>

      {hive.operatingProfile && (
        <section className="space-y-4 rounded-lg border p-6">
          <div>
            <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Operating profile</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Durable operating context for this {hive.kind?.replace("_", " ") ?? "hive"}. This is injected into agent context and should capture outcomes, constraints, approvals, and stop rules.
            </p>
            {hive.operatingProfile.isDerived && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Derived from setup. Save changes here to make it explicit.</p>
            )}
          </div>
          <form onSubmit={saveOperatingProfile} className="space-y-3">
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">Purpose</span>
              <textarea name="purpose" rows={2} defaultValue={hive.operatingProfile.purpose} className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800" />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">Desired outcome</span>
              <textarea name="desiredOutcome" rows={2} defaultValue={hive.operatingProfile.desiredOutcome} className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800" />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">Current 30-day outcome</span>
              <textarea name="current30DayOutcome" rows={2} defaultValue={hive.operatingProfile.current30DayOutcome ?? ""} className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["constraints", "Constraints"],
                ["approvalRules", "Approval rules"],
                ["forbiddenActions", "Forbidden actions"],
                ["importantContext", "Important context"],
                ["successCriteria", "Success criteria"],
                ["stopOrPauseCriteria", "Stop / pause criteria"],
              ].map(([key, label]) => (
                <label key={key} className="block space-y-1 text-sm">
                  <span className="font-medium text-zinc-700 dark:text-zinc-200">{label}</span>
                  <textarea
                    name={key}
                    rows={4}
                    defaultValue={(hive.operatingProfile?.[key as keyof OperatingProfile] as string[] | undefined)?.join("\n") ?? ""}
                    className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                    placeholder="One item per line"
                  />
                </label>
              ))}
            </div>
            <button disabled={profileSaveState === "saving"} className="cursor-pointer rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-wait disabled:opacity-50">
              {profileSaveState === "saving" ? "Saving…" : "Save operating profile"}
            </button>
            {profileSaveState === "saved" && <span className="ml-3 text-sm text-green-600 dark:text-green-400">✓ Saved</span>}
            {profileSaveState === "error" && <span className="ml-3 text-sm text-red-600 dark:text-red-400">Save failed</span>}
          </form>
        </section>
      )}

      <HiveConnectorsPanel hiveId={id} />

      <HiveRecordsPanel hiveId={id} hiveKind={hive.kind ?? "business"} />

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Description</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">One-line tagline — shows on hive cards and lists.</p>
        </div>
        <textarea
          rows={2}
          value={hive.description ?? ""}
          onChange={e => setHive({ ...hive, description: e.target.value })}
          className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
        />
      </section>

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Mission</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            The overarching purpose of this hive — why it exists and what success looks like.
            Every agent working in this hive reads this before starting. Capped at 500 words in the rendered agent context.
          </p>
        </div>
        <textarea
          rows={10}
          value={hive.mission ?? ""}
          onChange={e => setHive({ ...hive, mission: e.target.value })}
          className="w-full rounded-md border px-3 py-2 font-mono text-sm dark:bg-zinc-800"
          placeholder="# Mission&#10;&#10;What this hive is here to accomplish…"
        />
      </section>

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Reference documents</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Upload owner-approved rules, FAQs, cancellation policies, SOPs, and other source material.
            Uploaded files are listed in agent context so workers know where to look, but file contents are only opened when relevant. All files are visible under the Files tab.
          </p>
        </div>
        <form onSubmit={uploadReferenceDocument} className="space-y-3">
          <input
            value={referenceTitle}
            onChange={e => setReferenceTitle(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            placeholder="Optional title / label (e.g. Cancellation policy)"
          />
          <input
            type="file"
            onChange={e => setSelectedReferenceFile(e.target.files?.[0] ?? null)}
            className="block w-full cursor-pointer rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
            accept=".txt,.md,.markdown,.json,.csv,.yaml,.yml,.pdf,.doc,.docx"
          />
          <div className="flex items-center gap-3">
            <button
              disabled={uploadSaveState === "uploading"}
              className="cursor-pointer rounded-md border px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-zinc-800"
            >
              {uploadSaveState === "uploading" ? "Uploading…" : "Upload reference document"}
            </button>
            {uploadSaveState === "uploaded" && <span className="text-sm text-green-600 dark:text-green-400">✓ Uploaded</span>}
            {uploadSaveState === "error" && <span className="text-sm text-red-600 dark:text-red-400">Upload failed</span>}
          </div>
        </form>
      </section>

      <section className="space-y-4 rounded-lg border p-6">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Software and systems used</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            List the apps, accounts, and operational systems this hive uses — e.g. Gmail, NewBook, Xero, Shopify.
            Agents receive this as reference context even before a connector exists.
          </p>
        </div>
        <textarea
          rows={5}
          value={hive.softwareStack ?? ""}
          onChange={e => setHive({ ...hive, softwareStack: e.target.value })}
          className="w-full rounded-md border px-3 py-2 font-mono text-sm dark:bg-zinc-800"
          placeholder="- Gmail: customer email&#10;- NewBook: bookings/PMS&#10;- ..."
        />
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={async () => {
            if (!target.confirmCrossHiveWrite("Saving hive profile changes")) return;
            setChangesSaveState("saving");
            const res = await fetch(`/api/hives/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                description: hive.description ?? "",
                mission: hive.mission ?? "",
                softwareStack: hive.softwareStack ?? "",
              }),
            });
            if (res.ok) {
              setChangesSaveState("saved");
              reload();
              setTimeout(() => setChangesSaveState("idle"), 2000);
            } else {
              setChangesSaveState("error");
              setTimeout(() => setChangesSaveState("idle"), 4000);
            }
          }}
          disabled={changesSaveState === "saving"}
          className="cursor-pointer rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {changesSaveState === "saving" ? "Saving…" : "Save changes"}
        </button>
        {changesSaveState === "saved" && (
          <span className="text-sm text-green-600 dark:text-green-400">✓ Saved</span>
        )}
        {changesSaveState === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400">Save failed — check console</span>
        )}
      </div>

      <section className="space-y-4 rounded-lg border p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Targets</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Only <span className="font-medium">Open</span> targets are injected into agent spawns.
              Achieved and abandoned targets stay here for history.
            </p>
          </div>
          <button
            onClick={addTarget}
            className="cursor-pointer shrink-0 rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            + Add target
          </button>
        </div>

        <div className="space-y-3">
          {openTargets.length === 0 && <p className="text-sm text-zinc-400">No open targets yet.</p>}
          {openTargets.map((t, i) => renderTarget(t, i, true))}
        </div>

        {historyTargets.length > 0 && (
          <div className="mt-2 border-t pt-4">
            <button
              onClick={() => setShowHistory(v => !v)}
              className="cursor-pointer text-sm text-zinc-600 hover:underline dark:text-zinc-400"
            >
              {showHistory ? "Hide" : "Show"} achieved/abandoned ({historyTargets.length})
            </button>
            {showHistory && (
              <div className="mt-3 space-y-3">
                {historyTargets.map((t, i) => renderTarget(t, i, false))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border p-6">
        <button
          onClick={() => showPreview ? setShowPreview(false) : loadPreview()}
          className="cursor-pointer text-sm text-zinc-600 hover:underline dark:text-zinc-300"
        >
          {showPreview ? "Hide" : "Show"} agent context preview
        </button>
        {showPreview && (
          <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-4 text-xs font-mono text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            {contextPreview || "(empty)"}
          </pre>
        )}
      </section>
    </div>
  );
}
