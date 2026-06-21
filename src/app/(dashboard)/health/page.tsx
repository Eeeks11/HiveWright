"use client";

import { useEffect, useState } from "react";
import type { DiagnosticStatus, DiagnosticSummary, HiveWrightDiagnosticsScope } from "@/diagnostics/types";
import type { SetupRuntimeReadinessWarning } from "@/setup-readiness/runtime";

type HealthPageState = {
  checkedAt: string;
  scope?: HiveWrightDiagnosticsScope;
  summary: DiagnosticSummary;
  diagnostics: DiagnosticStatus[];
  setupReadiness?: {
    checkedAt: string;
    warningSources: SetupRuntimeReadinessWarning[];
  };
};

export default function DashboardHealthPage() {
  const [state, setState] = useState<HealthPageState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/diagnostics", { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(body.error ?? "Failed to load diagnostics");
          return;
        }
        setState(body.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-6">
      <header className="flex flex-col gap-2 border-b border-white/10 pb-4">
        <p className="text-sm text-muted-foreground">HiveWright runtime</p>
        <h1 className="text-2xl font-semibold text-foreground">Health</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Controller-global product/runtime diagnostics for the app, dispatcher, queue, execution runs, and providers.
        </p>
      </header>

      {error ? (
        <section className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
          {error}
        </section>
      ) : null}

      {!state && !error ? (
        <section className="rounded-md border border-white/10 p-4 text-sm text-muted-foreground">
          Loading health diagnostics...
        </section>
      ) : null}

      {state ? (
        <>
          <section className="grid gap-3 md:grid-cols-4">
            <SummaryTile label="Active runtime" value={state.summary.ready ? "ready" : "not ready"} />
            <SummaryTile label="Worst severity" value={state.summary.severity} />
            <SummaryTile label="Owner action" value={state.summary.ownerActionRequired ? "needed" : "none"} />
            <SummaryTile label="Setup debt" value={formatSetupDebtCount(state.setupReadiness?.warningSources)} />
          </section>

          <section className="rounded-md border border-white/10 p-4 text-sm text-muted-foreground">
            <p>
              {state.scope?.summary
                ?? "Active runtime readiness is based on app, dispatcher, queue, execution-run, and provider diagnostics."}
              {" "}
              Optional setup debt is shown separately so missing or unchecked local tools do not look like owner escalations.
            </p>
          </section>

          {state.setupReadiness ? (
            <section className="rounded-md border border-amber-500/20 bg-amber-500/5 p-4">
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium uppercase text-amber-100">Optional setup debt</p>
                <h2 className="text-lg font-semibold text-foreground">Readiness warning sources</h2>
                <p className="text-sm text-muted-foreground">
                  These checks explain warning severity from optional local setup. They are operational debt, not owner-action escalations.
                </p>
              </div>
              {state.setupReadiness.warningSources.length > 0 ? (
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {state.setupReadiness.warningSources.map((warning) => (
                    <article key={warning.source} className="rounded-md border border-white/10 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium text-foreground">{warning.label}</h3>
                        <span className="rounded-full border border-amber-300/40 px-2 py-0.5 text-xs text-amber-100">
                          {warning.source}: {warning.status}
                        </span>
                      </div>
                      <p className="mt-2 text-muted-foreground">{warning.detail}</p>
                      <p className="mt-1 text-xs text-amber-100">{warning.nextStep}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-emerald-200">No optional setup warning sources reported.</p>
              )}
            </section>
          ) : null}

          <section className="overflow-hidden rounded-md border border-white/10">
            <div className="grid grid-cols-[140px_1fr] gap-3 border-b border-white/10 px-4 py-3 text-xs font-medium uppercase text-muted-foreground md:grid-cols-[160px_220px_1fr]">
              <span>Status</span>
              <span className="hidden md:block">Active runtime check</span>
              <span>Summary</span>
            </div>
            {state.diagnostics.map((item) => (
              <article
                key={item.id}
                className="grid grid-cols-[140px_1fr] gap-3 border-b border-white/10 px-4 py-3 text-sm last:border-b-0 md:grid-cols-[160px_220px_1fr]"
              >
                <span className={severityClass(item.severity)}>{item.severity}</span>
                <span className="hidden min-w-0 truncate text-muted-foreground md:block">{item.label}</span>
                <div className="min-w-0 space-y-1">
                  <p className="text-foreground">{item.summary}</p>
                  {item.details ? <p className="text-xs text-muted-foreground">{item.details}</p> : null}
                  {item.recommendedAction ? (
                    <p className="text-xs text-amber-100">{item.recommendedAction}</p>
                  ) : null}
                </div>
              </article>
            ))}
          </section>
        </>
      ) : null}
    </main>
  );
}

function formatSetupDebtCount(warnings: SetupRuntimeReadinessWarning[] | undefined) {
  if (!warnings) return "not checked";
  return warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`;
}

function SummaryTile(props: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 p-4">
      <p className="text-xs uppercase text-muted-foreground">{props.label}</p>
      <p className="mt-2 text-lg font-semibold text-foreground">{props.value}</p>
    </div>
  );
}

function severityClass(severity: DiagnosticStatus["severity"]) {
  switch (severity) {
    case "critical":
      return "font-medium text-red-200";
    case "warning":
      return "font-medium text-amber-200";
    case "info":
      return "font-medium text-sky-200";
    case "ok":
      return "font-medium text-emerald-200";
  }
}
