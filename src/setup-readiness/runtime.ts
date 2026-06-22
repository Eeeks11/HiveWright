import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Sql } from "postgres";
import { loadModelRoutingView, type ModelRoutingView } from "@/model-routing/registry";
import { sanitizeError } from "@/memory/local-embedding-setup";
import { getCanonicalOllamaEndpoint } from "@/ollama/endpoint";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 5_000;
const OLLAMA_TIMEOUT_MS = 5_000;

export type SetupReadinessWarningPolicy = "active_provider" | "optional_runtime";

export type RuntimeStatus = "ready" | "check_required" | "missing";

export interface RuntimeReadiness {
  label: string;
  installed: boolean;
  status: RuntimeStatus;
  detail: string;
  nextStep: string;
}

export type SetupRuntimeReadinessSnapshot = {
  checkedAt: string;
  runtimes: Record<string, RuntimeReadiness>;
};

export type SetupRuntimeReadinessWarning = {
  source: string;
  label: string;
  status: Exclude<RuntimeStatus, "ready">;
  policy: SetupReadinessWarningPolicy;
  detail: string;
  nextStep: string;
};

type ActiveRuntimeSourceRow = {
  provider: string | null;
  adapter_type: string | null;
};

type LoadRoutingView = (sql: Sql, hiveId: string) => Promise<ModelRoutingView>;

export async function collectSetupRuntimeReadiness(): Promise<SetupRuntimeReadinessSnapshot> {
  const [codex, claudeCode, gemini, ollama] = await Promise.all([
    checkCliRuntime("codex", "Codex", ["--version"], "Open a terminal on this server and run `codex login`, then refresh this check.", ["login", "status"]),
    checkCliRuntime("claude", "Claude Code", ["--version"], "Open a terminal on this server and run `claude login`, then refresh this check."),
    checkCliRuntime("gemini", "Gemini CLI", ["--version"], "Open a terminal on this server and sign in to Gemini CLI, then refresh this check."),
    checkOllamaRuntime(),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    runtimes: {
      codex,
      "claude-code": claudeCode,
      gemini,
      ollama,
    },
  };
}

export function listSetupRuntimeReadinessWarnings(
  snapshot: SetupRuntimeReadinessSnapshot,
  options: { activeSources?: Iterable<string> } = {},
): SetupRuntimeReadinessWarning[] {
  const activeSources = new Set(Array.from(options.activeSources ?? []).map(normalizeRuntimeSource));
  return Object.entries(snapshot.runtimes)
    .filter((entry): entry is [string, RuntimeReadiness & { status: Exclude<RuntimeStatus, "ready"> }] => entry[1].status !== "ready")
    .map(([source, runtime]) => ({
      source,
      label: runtime.label,
      status: runtime.status,
      policy: activeSources.has(normalizeRuntimeSource(source)) ? "active_provider" : "optional_runtime",
      detail: runtime.detail,
      nextStep: runtime.nextStep,
    }));
}

export function listActiveProviderReadinessWarnings(
  snapshot: SetupRuntimeReadinessSnapshot,
  activeSources: Iterable<string>,
): SetupRuntimeReadinessWarning[] {
  return listSetupRuntimeReadinessWarnings(snapshot, { activeSources })
    .filter((warning) => warning.policy === "active_provider");
}

export async function listActiveSetupRuntimeSources(
  sql: Sql,
  options: { hiveId?: string; loadRoutingView?: LoadRoutingView } = {},
): Promise<string[]> {
  if (options.hiveId) {
    const view = await (options.loadRoutingView ?? loadModelRoutingView)(sql, options.hiveId);
    return listActiveSetupRuntimeSourcesForRoutingView(view);
  }

  const rows = await sql<ActiveRuntimeSourceRow[]>`
    SELECT DISTINCT provider, adapter_type
    FROM hive_models
    WHERE enabled = true
  `;

  return Array.from(new Set(rows.flatMap((row) => runtimeSourcesForConfiguredRoute(row))))
    .sort();
}

export function listActiveSetupRuntimeSourcesForRoutingView(
  view: Pick<ModelRoutingView, "models" | "policy">,
): string[] {
  const policyCandidatesByRoute = new Map(view.policy.candidates.map((candidate) => [
    `${candidate.adapterType}:${candidate.model}`,
    candidate,
  ]));
  const sources: string[] = view.models
    .filter((model) => model.hiveModelEnabled && model.routingEnabled)
    .filter((model) => {
      const candidate = policyCandidatesByRoute.get(`${model.adapterType}:${model.model}`);
      return isActiveRoutePoolCandidate(candidate);
    })
    .flatMap((model) => runtimeSourcesForConfiguredRoute({
      provider: model.provider,
      adapter_type: model.adapterType,
    }));

  return Array.from(new Set<string>(sources)).sort();
}

function isActiveRoutePoolCandidate(
  candidate: ModelRoutingView["policy"]["candidates"][number] | undefined,
): boolean {
  if (!candidate) return false;
  if (candidate.enabled === false) return false;
  const membership = candidate.canonicalRouteSet?.membership;
  return membership !== "excluded" && membership !== "intentionally_disabled";
}

export function runtimeSourcesForConfiguredRoute(input: { provider: string | null; adapter_type: string | null }): string[] {
  const provider = normalizeRuntimeSource(input.provider ?? "");
  const adapterType = normalizeRuntimeSource(input.adapter_type ?? "");
  const tokens = new Set([provider, adapterType]);
  const sources: string[] = [];

  if (tokens.has("ollama") || tokens.has("local") || adapterType.includes("ollama")) sources.push("ollama");
  if (tokens.has("codex") || tokens.has("openai-codex")) sources.push("codex");
  if (tokens.has("claude") || tokens.has("claude-code")) sources.push("claude-code");
  if (tokens.has("gemini") || tokens.has("google-gemini")) sources.push("gemini");

  return sources;
}

async function checkCliRuntime(command: string, label: string, args: string[], nextStep: string, authArgs?: string[]): Promise<RuntimeReadiness> {
  try {
    await execFileAsync(command, args, { timeout: CLI_TIMEOUT_MS });
    if (authArgs) {
      try {
        await execFileAsync(command, authArgs, { timeout: CLI_TIMEOUT_MS });
        return {
          label,
          installed: true,
          status: "ready",
          detail: `${label} is installed and its CLI login status is usable.`,
          nextStep: "Ready for setup. Setup health can still run deeper model probes after launch.",
        };
      } catch {
        return {
          label,
          installed: true,
          status: "check_required",
          detail: `${label} is installed, but the CLI login status is not ready.`,
          nextStep,
        };
      }
    }
    return {
      label,
      installed: true,
      status: "check_required",
      detail: `${label} is installed. HiveWright still needs a runtime-specific login check before launch.`,
      nextStep,
    };
  } catch (err) {
    const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "";
    const missing = code === "ENOENT";
    return {
      label,
      installed: false,
      status: "missing",
      detail: missing ? `${label} command is not installed on this server.` : `${label} could not be checked. ${sanitizeError(err)}`,
      nextStep: missing ? `Install ${label} on the HiveWright server or choose a different runtime.` : nextStep,
    };
  }
}

async function checkOllamaRuntime(): Promise<RuntimeReadiness> {
  const ollamaEndpoint = getCanonicalOllamaEndpoint();
  try {
    const res = await fetch(`${ollamaEndpoint}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        label: "Ollama",
        installed: false,
        status: "missing",
        detail: `Ollama tags endpoint returned HTTP ${res.status}.`,
        nextStep: "Start Ollama on the HiveWright server, then run setup health again.",
      };
    }
    const body = await res.json().catch(() => ({}));
    const count = Array.isArray(body.models) ? body.models.length : 0;
    return {
      label: "Ollama",
      installed: true,
      status: "ready",
      detail: count > 0 ? `Ollama is reachable with ${count} local model${count === 1 ? "" : "s"}.` : "Ollama is reachable, but no local models were reported.",
      nextStep: count > 0 ? "Run setup health to prove the selected local model can answer." : "Pull a worker model in Ollama before selecting local models for agents.",
    };
  } catch (err) {
    return {
      label: "Ollama",
      installed: false,
      status: "missing",
      detail: `Ollama is not reachable at ${ollamaEndpoint}. ${sanitizeError(err)}`,
      nextStep: "Install/start Ollama on the HiveWright server, then run setup health again.",
    };
  }
}

function normalizeRuntimeSource(value: string): string {
  return value.trim().toLowerCase();
}
