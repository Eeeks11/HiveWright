"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  estimateEtaSeconds,
  formatEta,
  type ObservedReembedProgress,
} from "@/memory/reembed-progress";

type EmbeddingProvider =
  | "ollama"
  | "openai"
  | "voyage"
  | "cohere"
  | "mistral"
  | "google"
  | "huggingface"
  | "openrouter";

type EmbeddingStatus = "ready" | "reembedding" | "error";

interface CatalogModel {
  modelName: string;
  dimension: number;
}

interface CatalogProvider {
  provider: EmbeddingProvider;
  label: string;
  models: CatalogModel[];
}

interface EmbeddingConfigResponse {
  config: {
    id: string;
    provider: EmbeddingProvider;
    modelName: string;
    dimension: number;
    apiCredentialKey: string | null;
    endpointOverride: string | null;
    status: EmbeddingStatus;
    lastReembeddedId: string | null;
    reembedTotal: number;
    reembedProcessed: number;
    reembedStartedAt: string | null;
    reembedFinishedAt: string | null;
    lastError: string | null;
    updatedAt: string;
    updatedBy: string | null;
  } | null;
  catalog: CatalogProvider[];
  errorSummary: {
    count: number;
    latestMessage: string | null;
  } | null;
  recentErrors: Array<{
    id: string;
    memoryEmbeddingId: string;
    sourceType: string;
    sourceId: string;
    chunkText: string;
    errorMessage: string;
    attemptCount: number;
    updatedAt: string;
  }>;
}

interface Credential {
  id: string;
  key: string;
  name: string;
}

interface LocalSetupStatus {
  platform: string;
  endpoint: string;
  ollamaReachable?: boolean;
  reachable?: boolean;
  installedModels?: string[];
  modelName?: string;
  modelInstalled: boolean;
  embeddingTest?: "not_run" | "passed" | "failed";
  embeddingTestOk?: boolean;
  defaultModel?: string;
  dimension?: number;
  error: string | null;
}

interface LocalSetupStep {
  label?: string;
  command?: string;
  url?: string;
  requiresConfirmation?: boolean;
}

interface LocalSetupResponse {
  status: LocalSetupStatus;
  plan: {
    platform: string;
    recommendedMode?: "auto" | "manual";
    autoAvailable?: boolean;
    autoRequiresAdmin?: boolean;
    autoSteps?: Array<LocalSetupStep & { requiresConfirmation?: boolean }>;
    manualSteps?: LocalSetupStep[];
    warnings?: string[];
    recommended?: {
      title: string;
      description: string;
      warnings: string[];
      actions: string[];
    };
    manual?: {
      title: string;
      steps: string[];
    };
  };
  defaultConfig: {
    provider: EmbeddingProvider;
    modelName: string;
    dimension: number;
    endpointOverride: string;
    apiCredentialKey: null;
  };
}

const LOCAL_PROVIDER: EmbeddingProvider = "ollama";

export default function EmbeddingsSettingsPage() {
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [provider, setProvider] = useState<EmbeddingProvider>(LOCAL_PROVIDER);
  const [modelName, setModelName] = useState("");
  const [apiCredentialKey, setApiCredentialKey] = useState("");
  const [endpointOverride, setEndpointOverride] = useState("");
  const [status, setStatus] = useState<EmbeddingStatus>("ready");
  const [progress, setProgress] = useState<ObservedReembedProgress | null>(null);
  const [previousProgress, setPreviousProgress] = useState<ObservedReembedProgress | null>(null);
  const [errorSummary, setErrorSummary] = useState<{ count: number; latestMessage: string | null } | null>(null);
  const [recentErrors, setRecentErrors] = useState<EmbeddingConfigResponse["recentErrors"]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [localSetup, setLocalSetup] = useState<LocalSetupResponse | null>(null);
  const [localSetupLoading, setLocalSetupLoading] = useState(true);
  const [localAction, setLocalAction] = useState<string | null>(null);
  const [showInstallConfirm, setShowInstallConfirm] = useState(false);

  const selectedProvider = useMemo(
    () => catalog.find((entry) => entry.provider === provider) ?? null,
    [catalog, provider],
  );
  const modelOptions = selectedProvider?.models ?? [];
  const selectedModel = modelOptions.find((entry) => entry.modelName === modelName) ?? modelOptions[0] ?? null;
  const dimension = selectedModel?.dimension ?? 0;
  const requiresCredential = provider !== LOCAL_PROVIDER;
  const hasCredentials = credentials.length > 0;
  const reembedRunning = status === "reembedding";
  const etaLabel = formatEta(estimateEtaSeconds(progress, previousProgress));
  const saveDisabled =
    saving ||
    loading ||
    !selectedModel ||
    reembedRunning ||
    (requiresCredential && (!hasCredentials || !apiCredentialKey));
  const localReachable = Boolean(localSetup?.status.ollamaReachable ?? localSetup?.status.reachable ?? false);
  const localEmbeddingTestPassed = Boolean(
    localSetup?.status.embeddingTest === "passed" || localSetup?.status.embeddingTestOk === true,
  );
  const localDefaultModel = localSetup?.defaultConfig.modelName ?? localSetup?.status.modelName ?? localSetup?.status.defaultModel ?? "nomic-embed-text-v2-moe:latest";
  const localDimension = localSetup?.defaultConfig.dimension ?? localSetup?.status.dimension ?? 768;
  const localReady = Boolean(localReachable && localSetup?.status.modelInstalled && localEmbeddingTestPassed);
  const localBusy = Boolean(localAction);
  const localDetectedPlatform = localSetup?.plan.platform ?? localSetup?.status.platform ?? "unknown";
  const localDetectedOsLabel = formatPlatformLabel(localDetectedPlatform);

  function toObservedProgress(
    config: EmbeddingConfigResponse["config"],
    summary: EmbeddingConfigResponse["errorSummary"],
  ): ObservedReembedProgress | null {
    if (!config) return null;
    return {
      processed: config.reembedProcessed ?? 0,
      total: config.reembedTotal ?? 0,
      failed: summary?.count ?? 0,
      cursor: config.lastReembeddedId,
      observedAt: Date.now(),
    };
  }

  useEffect(() => {
    let cancelled = false;

    async function loadConfig(background = false) {
      if (!background) setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/embedding-config");
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || `Failed to load embedding config (${res.status})`);
        }

        if (cancelled) return;

        const data = (body.data ?? null) as EmbeddingConfigResponse | null;
        const nextCatalog = data?.catalog ?? [];
        setCatalog(nextCatalog);

        const initialProvider = data?.config?.provider ?? nextCatalog[0]?.provider ?? LOCAL_PROVIDER;
        const initialProviderEntry = nextCatalog.find((entry) => entry.provider === initialProvider) ?? nextCatalog[0] ?? null;
        const initialModel =
          initialProviderEntry?.models.find((entry) => entry.modelName === data?.config?.modelName)
          ?? initialProviderEntry?.models[0]
          ?? null;

        setProvider(initialProvider);
        setModelName(initialModel?.modelName ?? "");
        setApiCredentialKey(data?.config?.apiCredentialKey ?? "");
        setEndpointOverride(data?.config?.endpointOverride ?? "");
        setStatus(data?.config?.status ?? "ready");
        const nextErrorSummary = data?.errorSummary ?? null;
        const nextProgress = toObservedProgress(data?.config ?? null, nextErrorSummary);
        setPreviousProgress((current) => (nextProgress ? current ?? nextProgress : current));
        setProgress(nextProgress);
        setErrorSummary(nextErrorSummary);
        setRecentErrors(data?.recentErrors ?? []);
        setUpdatedAt(data?.config?.updatedAt ?? null);
        setUpdatedBy(data?.config?.updatedBy ?? null);
        setAdvancedOpen(Boolean(data?.config?.endpointOverride));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load embedding settings");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!reembedRunning) return;
    const handle = window.setInterval(() => {
      void (async () => {
        const previous = progress;
        await (async () => {
          try {
            const res = await fetch("/api/embedding-config");
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(body.error || `Failed to refresh embedding config (${res.status})`);
            }

            const data = (body.data ?? null) as EmbeddingConfigResponse | null;
            const nextErrorSummary = data?.errorSummary ?? null;
            const nextProgress = toObservedProgress(data?.config ?? null, nextErrorSummary);

            setStatus(data?.config?.status ?? "ready");
            setUpdatedAt(data?.config?.updatedAt ?? null);
            setUpdatedBy(data?.config?.updatedBy ?? null);
            setErrorSummary(nextErrorSummary);
            setRecentErrors(data?.recentErrors ?? []);
            setPreviousProgress(previous);
            setProgress(nextProgress);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to refresh embedding settings");
          }
        })();
      })();
    }, 2500);

    return () => window.clearInterval(handle);
  }, [reembedRunning, progress]);

  useEffect(() => {
    if (!requiresCredential) {
      setApiCredentialKey("");
      return;
    }

    let cancelled = false;

    async function loadCredentials() {
      setCredentialsLoading(true);
      try {
        const res = await fetch("/api/credentials");
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || `Failed to load credentials (${res.status})`);
        }

        if (cancelled) return;

        const items = Array.isArray(body.data) ? body.data as Array<Record<string, unknown>> : [];
        const nextCredentials = items.map((item) => ({
          id: String(item.id),
          key: String(item.key),
          name: String(item.name ?? item.key),
        }));
        setCredentials(nextCredentials);
        if (!nextCredentials.some((item: Credential) => item.key === apiCredentialKey)) {
          setApiCredentialKey(nextCredentials[0]?.key ?? "");
        }
      } catch (err) {
        if (!cancelled) {
          setCredentials([]);
          setError(err instanceof Error ? err.message : "Failed to load credentials");
        }
      } finally {
        if (!cancelled) {
          setCredentialsLoading(false);
        }
      }
    }

    void loadCredentials();
    return () => {
      cancelled = true;
    };
  }, [requiresCredential, apiCredentialKey]);

  useEffect(() => {
    if (!selectedProvider) return;
    if (selectedProvider.models.some((entry) => entry.modelName === modelName)) return;
    setModelName(selectedProvider.models[0]?.modelName ?? "");
  }, [modelName, selectedProvider]);

  async function refreshLocalSetup(background = false) {
    if (!background) setLocalSetupLoading(true);
    try {
      const res = await fetch("/api/embedding-config/local-setup");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Failed to load local embedding setup (${res.status})`);
      }
      setLocalSetup((body.data ?? null) as LocalSetupResponse | null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load local embedding setup");
    } finally {
      if (!background) setLocalSetupLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLocalSetupLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/embedding-config/local-setup");
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || `Failed to load local embedding setup (${res.status})`);
        }
        if (!cancelled) setLocalSetup((body.data ?? null) as LocalSetupResponse | null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load local embedding setup");
      } finally {
        if (!cancelled) setLocalSetupLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runLocalSetupAction(action: "install" | "pull" | "use") {
    if (!localSetup) return;
    setLocalAction(action);
    setError(null);
    setSuccess(null);
    try {
      const endpoint =
        action === "install"
          ? "/api/embedding-config/local-setup/install-ollama"
          : action === "pull"
            ? "/api/embedding-config/local-setup/pull-model"
            : "/api/embedding-config/local-setup/use";
      const body =
        action === "install"
          ? { confirmed: true }
          : action === "pull"
            ? { modelName: localSetup.defaultConfig.modelName }
            : undefined;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || `Local setup action failed (${res.status})`);
      }

      if (action === "use") {
        const nextConfig = payload.data?.config;
        setProvider(nextConfig?.provider ?? localSetup.defaultConfig.provider);
        setModelName(nextConfig?.modelName ?? localSetup.defaultConfig.modelName);
        setEndpointOverride(nextConfig?.endpointOverride ?? localSetup.defaultConfig.endpointOverride);
        setApiCredentialKey("");
        setStatus(nextConfig?.status ?? "ready");
        const nextErrorSummary = payload.data?.errorSummary ?? null;
        const nextProgress = toObservedProgress(nextConfig ?? null, nextErrorSummary);
        setPreviousProgress(null);
        setProgress(nextProgress);
        setErrorSummary(nextErrorSummary);
        setRecentErrors(payload.data?.recentErrors ?? []);
        setUpdatedAt(nextConfig?.updatedAt ?? null);
        setUpdatedBy(nextConfig?.updatedBy ?? null);
        setSuccess("Local embedding config saved. Re-embedding has started.");
      } else {
        const nextStatus = payload.data?.status ?? payload.data?.result?.status ?? null;
        if (nextStatus) {
          setLocalSetup({ ...localSetup, status: nextStatus });
        } else {
          await refreshLocalSetup(true);
        }
        setSuccess(action === "install" ? "Ollama install check completed." : "Default local embedding model pull requested.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Local setup action failed");
    } finally {
      setLocalAction(null);
      setShowInstallConfirm(false);
    }
  }

  const localAutoSteps = localSetup
    ? localSetup.plan.autoSteps?.map((step) => step.command ?? step.url ?? step.label ?? "").filter(Boolean)
      ?? localSetup.plan.recommended?.actions
      ?? []
    : [];
  const localManualSteps = localSetup
    ? localSetup.plan.manualSteps?.map((step) => step.command ?? step.url ?? step.label ?? "").filter(Boolean)
      ?? localSetup.plan.manual?.steps
      ?? []
    : [];
  const localWarnings = localSetup
    ? localSetup.plan.warnings ?? localSetup.plan.recommended?.warnings ?? []
    : [];

  async function handleSave() {
    if (!selectedModel) return;

    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/embedding-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          modelName: selectedModel.modelName,
          dimension: selectedModel.dimension,
          apiCredentialKey: requiresCredential ? apiCredentialKey || null : null,
          endpointOverride: endpointOverride.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Failed to save embedding config (${res.status})`);
      }

      const nextConfig = body.data?.config;
      setStatus(nextConfig?.status ?? "ready");
      const nextErrorSummary = body.data?.errorSummary ?? null;
      const nextProgress = toObservedProgress(nextConfig ?? null, nextErrorSummary);
      setPreviousProgress(null);
      setProgress(nextProgress);
      setErrorSummary(nextErrorSummary);
      setRecentErrors(body.data?.recentErrors ?? []);
      setUpdatedAt(nextConfig?.updatedAt ?? null);
      setUpdatedBy(nextConfig?.updatedBy ?? null);
      setSuccess(
        body.data?.reembedRequested
          ? "Embedding config saved. Re-embedding has started."
          : "Embedding config unchanged. Existing embeddings are already aligned.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save embedding config");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Embedding configuration</h1>
        <p className="max-w-3xl text-sm text-zinc-500">
          Choose the provider, model, and credential HiveWright uses for memory embeddings.
          Dimension is fixed by the selected model so the saved payload stays valid.
        </p>
      </div>

      <section className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-5 text-sm text-emerald-950 dark:border-emerald-400/20 dark:bg-emerald-400/[0.06] dark:text-emerald-100">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">Local-first memory setup</h2>
            <p className="max-w-3xl text-sm">
              Set up HiveWright&apos;s recommended local memory engine without needing to know endpoint URLs.
              Advanced remote endpoints stay available below.
            </p>
          </div>
          {localReady ? (
            <span className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs font-medium uppercase tracking-wide">
              Local memory engine active
            </span>
          ) : null}
        </div>

        {localSetupLoading ? (
          <p className="mt-4">Checking local setup…</p>
        ) : localSetup ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-emerald-300/60 bg-white/70 px-4 py-3 dark:border-emerald-400/20 dark:bg-zinc-950/60">
              <p className="font-medium">
                {localReachable
                  ? localSetup.status.modelInstalled
                    ? localEmbeddingTestPassed
                      ? "Local memory engine ready"
                      : "Local memory engine found, but embedding test failed"
                    : "Local memory engine running; model missing"
                  : "Local memory engine not running"}
              </p>
              <p className="mt-1 text-xs opacity-80">
                Local Ollama status: {localReachable ? "reachable" : "unreachable"} at {localSetup.status.endpoint}. Model: {localDefaultModel} ({localDimension} dimensions).
              </p>
              <p className="mt-1 text-xs opacity-80">
                Detected HiveWright server OS: {localDetectedOsLabel}. The instructions below are generated for this OS because Ollama must run on the machine serving HiveWright, not necessarily the browser device.
              </p>
              {localSetup.status.error ? <p className="mt-2 text-xs text-red-700 dark:text-red-300">{localSetup.status.error}</p> : null}
            </div>

            {!localReachable ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-md border border-emerald-300/60 bg-white/70 p-4 dark:border-emerald-400/20 dark:bg-zinc-950/60">
                  <h3 className="font-medium">Recommended: Let HiveWright install and configure it</h3>
                  <p className="mt-1 text-xs opacity-80">
                    HiveWright will only run/download fixed allowlisted Ollama installer steps after explicit confirmation. OS/admin prompts may appear.
                  </p>
                  {localWarnings.length > 0 ? (
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-xs">
                      {localWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  ) : null}
                  {localAutoSteps.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {localAutoSteps.map((step) => <code key={step} className="block rounded bg-zinc-950 px-3 py-2 text-xs text-zinc-50">{step}</code>)}
                    </div>
                  ) : null}
                  {showInstallConfirm ? (
                    <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/[0.08] dark:text-amber-100">
                      <p className="font-medium">Confirm Ollama installation</p>
                      <p className="mt-1 text-xs">This runs only the allowlisted installer/download step shown above. No browser-supplied command will be accepted.</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void runLocalSetupAction("install")}
                          disabled={localBusy}
                          className="rounded-md bg-zinc-900 px-3 py-2 text-xs text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                        >
                          {localAction === "install" ? "Installing…" : "Yes, install Ollama"}
                        </button>
                        <button type="button" onClick={() => setShowInstallConfirm(false)} className="rounded-md border px-3 py-2 text-xs">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowInstallConfirm(true)}
                      disabled={localBusy}
                      className="mt-4 rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Install Ollama
                    </button>
                  )}
                </div>

                <div className="rounded-md border border-emerald-300/60 bg-white/70 p-4 dark:border-emerald-400/20 dark:bg-zinc-950/60">
                  <h3 className="font-medium">Manual: I&apos;ll install it myself</h3>
                  <p className="mt-1 text-xs opacity-80">Copy/paste these {localDetectedOsLabel} steps, then re-check local setup.</p>
                  <div className="mt-3 space-y-2">
                    {localManualSteps.map((step) => <code key={step} className="block rounded bg-zinc-950 px-3 py-2 text-xs text-zinc-50">{step}</code>)}
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshLocalSetup()}
                    disabled={localBusy || localSetupLoading}
                    className="mt-4 rounded-md border px-4 py-2 text-sm disabled:opacity-50"
                  >
                    Re-check local setup
                  </button>
                </div>
              </div>
            ) : !localSetup.status.modelInstalled ? (
              <button
                type="button"
                onClick={() => void runLocalSetupAction("pull")}
                disabled={localBusy}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {localAction === "pull" ? "Pulling model…" : "Pull default model"}
              </button>
            ) : !localEmbeddingTestPassed ? (
              <button
                type="button"
                onClick={() => void refreshLocalSetup()}
                disabled={localBusy || localSetupLoading}
                className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
              >
                Retry test
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runLocalSetupAction("use")}
                disabled={localBusy || reembedRunning}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {localAction === "use" ? "Saving local config…" : "Use local embeddings"}
              </button>
            )}
          </div>
        ) : (
          <button type="button" onClick={() => void refreshLocalSetup()} className="mt-4 rounded-md border px-4 py-2 text-sm">
            Set up local memory search
          </button>
        )}
      </section>

      <div className="rounded-lg border p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">Current runtime</h2>
            <p className="text-sm text-zinc-500">
              Saving updates the active embedding config and starts the re-embed migration immediately.
            </p>
          </div>
          <div className="rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
            Status: {status}
          </div>
        </div>

        {reembedRunning && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/[0.06] dark:text-amber-200">
            <p>Re-embedding is currently running. Saving is disabled until the migration finishes.</p>
            <p>
              Progress: {progress?.processed ?? 0} of {progress?.total ?? 0}
              {etaLabel ? ` · ETA ${etaLabel}` : ""}
            </p>
            {progress?.failed ? (
              <p>{progress.failed} chunk{progress.failed === 1 ? "" : "s"} failed so far.</p>
            ) : null}
          </div>
        )}

        {!reembedRunning && progress && progress.total > 0 ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-white/[0.06] dark:bg-zinc-900 dark:text-zinc-200">
            Latest run: {progress.processed} of {progress.total} processed.
            {progress.failed ? ` ${progress.failed} failed.` : " No chunk failures recorded."}
          </div>
        ) : null}

        {errorSummary ? (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/[0.06] dark:text-red-200">
            {errorSummary.count} re-embed error{errorSummary.count === 1 ? "" : "s"} logged.
            {errorSummary.latestMessage ? ` Latest: ${errorSummary.latestMessage}` : ""}
          </div>
        ) : null}

        {recentErrors.length > 0 ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700 dark:border-white/[0.06] dark:bg-zinc-900 dark:text-zinc-200">
            <p className="font-medium">Recent row failures</p>
            <div className="mt-2 space-y-2">
              {recentErrors.slice(0, 3).map((item) => (
                <div key={item.id} className="rounded border border-zinc-200 bg-white px-3 py-2 dark:border-white/[0.06] dark:bg-zinc-950">
                  <p className="font-mono text-xs text-zinc-500">{item.sourceType} / {item.sourceId}</p>
                  <p>{item.errorMessage}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/[0.06] dark:text-red-200">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-400/20 dark:bg-green-400/[0.06] dark:text-green-200">
            {success}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2">
            <span className="text-sm font-medium">Provider</span>
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as EmbeddingProvider);
                setSuccess(null);
              }}
              disabled={loading || saving}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-900"
            >
              {catalog.map((entry) => (
                <option key={entry.provider} value={entry.provider}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <select
              value={selectedModel?.modelName ?? ""}
              onChange={(event) => {
                setModelName(event.target.value);
                setSuccess(null);
              }}
              disabled={loading || saving || modelOptions.length === 0}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-900"
            >
              {modelOptions.map((entry) => (
                <option key={entry.modelName} value={entry.modelName}>
                  {entry.modelName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="space-y-2">
          <span className="text-sm font-medium">Dimension</span>
          <input
            value={dimension > 0 ? String(dimension) : ""}
            readOnly
            className="w-full rounded-md border bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-950 dark:text-zinc-300"
          />
          <p className="text-xs text-zinc-500">
            Derived from the selected model and submitted as read-only metadata.
          </p>
        </label>

        {requiresCredential ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">API credential</p>
                <p className="text-xs text-zinc-500">
                  Required for managed providers. Select an existing credential key.
                </p>
              </div>
              <Link href="/setup" className="text-sm text-amber-700 hover:underline dark:text-amber-300">
                Add credential
              </Link>
            </div>

            {credentialsLoading ? (
              <p className="text-sm text-zinc-500">Loading credentials…</p>
            ) : hasCredentials ? (
              <select
                value={apiCredentialKey}
                onChange={(event) => {
                  setApiCredentialKey(event.target.value);
                  setSuccess(null);
                }}
                disabled={saving}
                className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-900"
              >
                <option value="">Select a credential</option>
                {credentials.map((credential) => (
                  <option key={credential.id} value={credential.key}>
                    {credential.key} ({credential.name})
                  </option>
                ))}
              </select>
            ) : (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/[0.06] dark:text-amber-200">
                No credentials are configured yet for cloud embedding providers. Add one in global
                settings, then return here to save this provider.
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-white/[0.06] dark:bg-zinc-900 dark:text-zinc-300">
            Ollama uses a local endpoint and does not require a stored API credential.
          </div>
        )}

        <details
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}
          className="rounded-md border p-4"
        >
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-4 space-y-2">
            <label className="space-y-2">
              <span className="text-sm font-medium">Endpoint override</span>
              <input
                value={endpointOverride}
                onChange={(event) => {
                  setEndpointOverride(event.target.value);
                  setSuccess(null);
                }}
                placeholder={provider === "ollama" ? "http://localhost:11434" : "https://your-endpoint.example.com"}
                disabled={loading || saving}
                className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-900"
              />
            </label>
            <p className="text-xs text-zinc-500">
              Optional for Ollama or self-hosted embedding endpoints. Leave blank to use the provider default.
            </p>
          </div>
        </details>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="text-xs text-zinc-500">
            {updatedAt ? `Last updated ${new Date(updatedAt).toLocaleString()}` : "No saved config yet."}
            {updatedBy ? ` by ${updatedBy}` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => window.location.reload()}
              disabled={loading || saving}
              className="rounded-md border px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-900"
            >
              Refresh
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saveDisabled}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {saving ? "Saving..." : reembedRunning ? "Re-embed running..." : "Save & re-embed"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatPlatformLabel(platform: string): string {
  switch (platform) {
    case "linux":
      return "Linux";
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    default:
      return platform || "unknown";
  }
}
