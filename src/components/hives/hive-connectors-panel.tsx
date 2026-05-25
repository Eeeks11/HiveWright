"use client";

import { Eye, Plug, Plus, Power, RefreshCw, TestTube } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-keys";

interface SetupField {
  key: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  type?: "text" | "url" | "password" | "textarea";
  required?: boolean;
}

interface ConnectorScope {
  key: string;
  label: string;
  kind: string;
  required: boolean;
}

interface ConnectorOperation {
  slug: string;
  label: string;
  outputSummary?: string;
  governance?: {
    effectType: string;
    defaultDecision: string;
    riskTier: string;
    dryRunSupported?: boolean;
  };
}

interface ConnectorDefinition {
  slug: string;
  name: string;
  category: string;
  description: string;
  icon: string | null;
  authType: "api_key" | "oauth2" | "webhook" | "none";
  setupFields: SetupField[];
  scopes?: ConnectorScope[];
  capabilities?: string[];
  operations: ConnectorOperation[];
  requiresDispatcherRestart?: boolean;
}

interface ConnectorInstall {
  id: string;
  hiveId: string;
  connectorSlug: string;
  connectorName?: string | null;
  displayName: string;
  config: Record<string, unknown>;
  credentialConfigured?: boolean;
  status: string;
  lastTestedAt: string | null;
  lastSyncedAt?: string | null;
  lastError: string | null;
  lastSyncError?: string | null;
  createdAt: string;
  successes7d: number;
  errors7d: number;
  grantedScopes?: string[];
  capabilities?: string[];
}

interface ConnectorAction {
  id: string;
  operation: string;
  state: string;
  roleSlug?: string | null;
  createdAt: string;
}

type LoadState = "idle" | "loading" | "loaded" | "error";

type PanelMessageValue = { id: string; kind: "ok" | "error"; text: string };

export function HiveConnectorsPanel({ hiveId }: { hiveId: string }) {
  const [catalog, setCatalog] = useState<ConnectorDefinition[]>([]);
  const [installs, setInstalls] = useState<ConnectorInstall[]>([]);
  const [actionsByInstall, setActionsByInstall] = useState<Record<string, ConnectorAction[]>>({});
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [selectedScopes, setSelectedScopes] = useState<Record<string, string[]>>({});
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState<PanelMessageValue | null>(null);

  const reload = useCallback(async () => {
    setLoadState("loading");
    try {
      const [catalogBody, installsBody] = await Promise.all([
        fetch(`/api/connectors?hiveId=${encodeURIComponent(hiveId)}`).then(readJson),
        fetch(`/api/connector-installs?hiveId=${encodeURIComponent(hiveId)}`).then(readJson),
      ]);
      setCatalog(catalogBody.data ?? []);
      setInstalls(installsBody.data ?? []);
      setLoadState("loaded");
    } catch {
      setLoadState("error");
    }
  }, [hiveId]);

  useEffect(() => {
    void queryKeys.connectors.catalog(hiveId);
    void queryKeys.connectors.installs(hiveId);
    void reload();
  }, [hiveId, reload]);

  useEffect(() => {
    if (installs.length === 0) {
      setActionsByInstall({});
      return;
    }
    let cancelled = false;
    Promise.all(installs.map(async (install) => {
      try {
        void queryKeys.connectors.actions(install.id);
        const body = await fetch(`/api/connector-installs/${install.id}/actions`).then(readJson);
        return [install.id, body.data ?? []] as const;
      } catch {
        return [install.id, []] as const;
      }
    })).then((entries) => {
      if (!cancelled) setActionsByInstall(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [installs]);

  const installedSlugs = useMemo(() => new Set(installs.map((install) => install.connectorSlug)), [installs]);
  const availableCatalog = useMemo(
    () => catalog.filter((connector) => !installedSlugs.has(connector.slug)),
    [catalog, installedSlugs],
  );

  async function runInstallAction(install: ConnectorInstall, action: "test" | "sync" | "toggle") {
    setBusy(`${install.id}:${action}`);
    setMessage(null);
    try {
      if (action === "test") {
        const res = await fetch(`/api/connector-installs/${install.id}/test`, { method: "POST" });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        const result = body.data ?? {};
        setMessage({
          id: install.id,
          kind: result.success ? "ok" : "error",
          text: result.success ? `Test passed (${result.durationMs ?? 0}ms).` : `Test failed: ${result.error ?? "unknown"}`,
        });
      } else if (action === "sync") {
        const res = await fetch(`/api/connector-installs/${install.id}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hiveId, streams: ["default"] }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        const data = body.data ?? {};
        setMessage({
          id: install.id,
          kind: "ok",
          text: `Sync queued: ${data.imported ?? 0} imported, ${data.updated ?? 0} updated, ${data.rejected ?? 0} rejected.`,
        });
      } else {
        const nextStatus = install.status === "active" ? "disabled" : "active";
        const res = await fetch(`/api/connector-installs/${install.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setMessage({ id: install.id, kind: "ok", text: `${nextStatus === "active" ? "Enabled" : "Disabled"}.` });
      }
      await reload();
    } catch (error) {
      setMessage({
        id: install.id,
        kind: "error",
        text: error instanceof Error ? error.message : "Connector action failed",
      });
    } finally {
      setBusy(null);
    }
  }

  function openInstaller(slug: string) {
    setExpanded(slug);
    setForm({});
    setDisplayName("");
    setSelectedScopes((current) => ({ ...current, [slug]: [] }));
    setMessage(null);
  }

  async function submitInstall(event: FormEvent<HTMLFormElement>, connector: ConnectorDefinition) {
    event.preventDefault();
    setBusy(connector.slug);
    setMessage(null);
    try {
      const res = await fetch("/api/connector-installs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId,
          connectorSlug: connector.slug,
          displayName: displayName.trim() || connector.name,
          fields: form,
          grantedScopes: selectedScopes[connector.slug] ?? [],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Install failed");
      setExpanded(null);
      setForm({});
      setDisplayName("");
      setMessage({ id: connector.slug, kind: "ok", text: "Installed." });
      await reload();
    } catch (error) {
      setMessage({
        id: connector.slug,
        kind: "error",
        text: error instanceof Error ? error.message : "Install failed",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Connectors</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Connected systems, health checks, sync state, and governed actions for this hive.
          </p>
        </div>
        <a
          href="/setup/connectors"
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-50 dark:text-amber-100 dark:hover:bg-white/[0.04]"
        >
          <Eye aria-hidden="true" className="size-4" />
          View actions
        </a>
      </div>

      {loadState === "error" && (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
          Failed to load connectors.
        </p>
      )}

      {installs.length === 0 && loadState !== "loading" ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500 dark:text-zinc-400">
          No connectors are installed for this hive. Integrations are optional; manual records still work.
        </p>
      ) : (
        <div className="space-y-3">
          {installs.map((install) => {
            const definition = catalog.find((connector) => connector.slug === install.connectorSlug);
            const actions = actionsByInstall[install.id] ?? [];
            const capabilities = install.capabilities?.length ? install.capabilities : definition?.capabilities ?? ["health"];
            const canSync = capabilities.includes("sync") || capabilities.includes("record_import");
            return (
              <article key={install.id} className="space-y-3 rounded-md border p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span aria-hidden="true" className="text-xl">{definition?.icon ?? <Plug className="size-5" />}</span>
                      <h3 className="font-medium text-zinc-900 dark:text-zinc-100">{install.displayName}</h3>
                      <span className={statusClass(install.status)}>{install.status}</span>
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {definition?.name ?? install.connectorName ?? install.connectorSlug}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatDateLabel("last tested", install.lastTestedAt)} / {formatDateLabel("last sync", install.lastSyncedAt ?? null)} / {install.successes7d} ok / {install.errors7d} err (7d)
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => runInstallAction(install, "test")}
                      disabled={busy !== null}
                      aria-label={`Test ${install.displayName}`}
                    >
                      <TestTube aria-hidden="true" />
                      Test
                    </Button>
                    {canSync && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => runInstallAction(install, "sync")}
                        disabled={busy !== null || install.status !== "active"}
                        aria-label={`Sync ${install.displayName}`}
                      >
                        <RefreshCw aria-hidden="true" />
                        Sync now
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant={install.status === "active" ? "outline" : "secondary"}
                      onClick={() => runInstallAction(install, "toggle")}
                      disabled={busy !== null}
                      aria-label={install.status === "active" ? `Disable ${install.displayName}` : `Enable ${install.displayName}`}
                    >
                      <Power aria-hidden="true" />
                      {install.status === "active" ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </div>

                {(install.lastError || install.lastSyncError) && (
                  <div className="space-y-1 rounded-md bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/20 dark:text-red-300">
                    {install.lastError && <p>Last error: {install.lastError}</p>}
                    {install.lastSyncError && <p>Last sync error: {install.lastSyncError}</p>}
                  </div>
                )}

                <div className="grid gap-3 text-xs md:grid-cols-3">
                  <div>
                    <p className="font-medium uppercase text-zinc-500 dark:text-zinc-400">Capabilities</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {capabilities.map((capability) => <Badge key={capability}>{capability}</Badge>)}
                    </div>
                  </div>
                  <div>
                    <p className="font-medium uppercase text-zinc-500 dark:text-zinc-400">Granted scopes</p>
                    <ul className="mt-1 space-y-1 text-zinc-600 dark:text-zinc-300">
                      {(install.grantedScopes ?? []).length > 0
                        ? install.grantedScopes?.map((scope) => <li key={scope}>{scope}</li>)
                        : <li>No scopes granted.</li>}
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium uppercase text-zinc-500 dark:text-zinc-400">Recent actions</p>
                    <ul className="mt-1 space-y-1 text-zinc-600 dark:text-zinc-300">
                      {actions.length > 0 ? actions.slice(0, 3).map((action) => (
                        <li key={action.id}>{action.operation} / {action.state}{action.roleSlug ? ` / ${action.roleSlug}` : ""}</li>
                      )) : <li>No recent actions.</li>}
                    </ul>
                  </div>
                </div>

                {definition && definition.operations.length > 0 && (
                  <div className="space-y-1 border-t pt-3 text-xs text-zinc-600 dark:border-white/[0.08] dark:text-zinc-300">
                    {definition.operations.map((operation) => (
                      <p key={operation.slug}>
                        {operation.label}
                        {operation.governance ? (
                          <span className="ml-1 text-zinc-500 dark:text-zinc-400">
                            {operation.governance.effectType} / {operation.governance.riskTier} / {operation.governance.defaultDecision}
                            {operation.governance.defaultDecision === "require_approval" ? " / approval-gated" : ""}
                          </span>
                        ) : null}
                      </p>
                    ))}
                  </div>
                )}

                {message?.id === install.id && <PanelMessage message={message} />}
              </article>
            );
          })}
        </div>
      )}

      {availableCatalog.length > 0 && (
        <div className="space-y-3 border-t pt-4 dark:border-white/[0.08]">
          <div>
            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Available connectors</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Setup fields marked as secrets are stored through credentials and are not echoed back.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {availableCatalog.map((connector) => {
              const open = expanded === connector.slug;
              return (
                <article key={connector.slug} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">{connector.name}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{connector.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(connector.capabilities ?? ["health"]).map((capability) => <Badge key={capability}>{capability}</Badge>)}
                      </div>
                    </div>
                    {connector.authType === "oauth2" ? (
                      <a
                        href={`/api/oauth/${connector.slug}/start?hiveId=${encodeURIComponent(hiveId)}&displayName=${encodeURIComponent(connector.name)}`}
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-sm text-amber-900 hover:bg-amber-50 dark:text-amber-100 dark:hover:bg-white/[0.04]"
                      >
                        <Plug aria-hidden="true" className="size-4" />
                        Connect
                      </a>
                    ) : (
                      <Button type="button" size="sm" variant="outline" onClick={() => open ? setExpanded(null) : openInstaller(connector.slug)}>
                        <Plus aria-hidden="true" />
                        Add
                      </Button>
                    )}
                  </div>

                  {open && connector.authType !== "oauth2" && (
                    <form onSubmit={(event) => submitInstall(event, connector)} className="mt-3 space-y-3 border-t pt-3 dark:border-white/[0.08]">
                      <label className="block space-y-1 text-sm">
                        <span className="font-medium text-zinc-700 dark:text-zinc-200">Display name</span>
                        <input
                          value={displayName}
                          onChange={(event) => setDisplayName(event.target.value)}
                          placeholder={connector.name}
                          className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                        />
                      </label>

                      {connector.setupFields.map((field) => (
                        <label key={field.key} className="block space-y-1 text-sm">
                          <span className="font-medium text-zinc-700 dark:text-zinc-200">{field.label}{field.required ? " *" : ""}</span>
                          {field.type === "textarea" ? (
                            <textarea
                              required={field.required}
                              value={form[field.key] ?? ""}
                              onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                              placeholder={field.placeholder}
                              rows={2}
                              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                            />
                          ) : (
                            <input
                              required={field.required}
                              type={field.type === "password" ? "password" : field.type === "url" ? "url" : "text"}
                              value={form[field.key] ?? ""}
                              onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                              placeholder={field.placeholder}
                              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                            />
                          )}
                          {field.helpText && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{field.helpText}</span>}
                        </label>
                      ))}

                      {connector.scopes && connector.scopes.length > 0 && (
                        <fieldset className="space-y-2">
                          <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Scopes</legend>
                          {connector.scopes.map((scope) => (
                            <label key={scope.key} className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                              <input
                                type="checkbox"
                                checked={scope.required || (selectedScopes[connector.slug] ?? []).includes(scope.key)}
                                disabled={scope.required}
                                onChange={(event) => setSelectedScopes((current) => {
                                  const next = new Set(current[connector.slug] ?? []);
                                  if (event.target.checked) next.add(scope.key);
                                  else next.delete(scope.key);
                                  return { ...current, [connector.slug]: Array.from(next) };
                                })}
                              />
                              <span>{scope.label} <span className="text-zinc-500">({scope.key}{scope.required ? ", required" : ""})</span></span>
                            </label>
                          ))}
                        </fieldset>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        <Button type="submit" size="sm" disabled={busy === connector.slug}>
                          <Plus aria-hidden="true" />
                          {busy === connector.slug ? "Installing..." : `Install ${connector.name}`}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(null)}>Cancel</Button>
                      </div>
                    </form>
                  )}
                  {message?.id === connector.slug && <PanelMessage message={message} />}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

async function readJson(res: Response) {
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

function formatDateLabel(label: string, value: string | null) {
  if (!value) return `${label} never`;
  return `${label} ${new Date(value).toLocaleString()}`;
}

function statusClass(status: string) {
  if (status === "active") return "rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (status === "broken") return "rounded bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300";
  return "rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-100 dark:ring-amber-500/20">
      {children}
    </span>
  );
}

function PanelMessage({ message }: { message: PanelMessageValue }) {
  return (
    <p className={message.kind === "ok" ? "text-xs text-emerald-700 dark:text-emerald-300" : "text-xs text-red-700 dark:text-red-300"}>
      {message.text}
    </p>
  );
}
