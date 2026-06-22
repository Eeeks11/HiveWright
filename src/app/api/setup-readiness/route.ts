import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canAccessHive } from "@/auth/users";
import { loadModelRoutingView } from "@/model-routing/registry";
import { sql } from "../_lib/db";
import { requireApiAuth, requireApiUser } from "../_lib/auth";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";
import { sanitizeError } from "@/memory/local-embedding-setup";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 5_000;
const OLLAMA_TIMEOUT_MS = 5_000;
const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";
const RUNTIME_KEYS = ["codex", "claude-code", "gemini", "ollama"] as const;

type RuntimeStatus = "ready" | "check_required" | "missing";
type RuntimeKey = (typeof RUNTIME_KEYS)[number];

interface RuntimeReadiness {
  label: string;
  installed: boolean;
  status: RuntimeStatus;
  detail: string;
  nextStep: string;
}

export async function GET(request?: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const runtimeKeys = await resolveRuntimeKeys(request);
  if (runtimeKeys instanceof Response) return runtimeKeys;
  const runtimes = Object.fromEntries(
    await Promise.all(
      runtimeKeys.map(async (runtimeKey) => [runtimeKey, await checkRuntime(runtimeKey)] as const),
    ),
  );

  return jsonOk({
    checkedAt: new Date().toISOString(),
    runtimes,
  });
}

async function resolveRuntimeKeys(request?: Request): Promise<RuntimeKey[] | Response> {
  if (!request) return [...RUNTIME_KEYS];

  const hiveId = parseSearchParams(request.url).get("hiveId");
  if (!hiveId) return [...RUNTIME_KEYS];

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  const view = await loadModelRoutingView(sql, hiveId);
  const activeRuntimeKeys = new Set<RuntimeKey>();
  for (const model of view.models) {
    if (!model.hiveModelEnabled || !model.routingEnabled) continue;
    const runtimeKey = normalizeRuntimeKey(model.adapterType);
    if (runtimeKey) activeRuntimeKeys.add(runtimeKey);
  }

  return RUNTIME_KEYS.filter((runtimeKey) => activeRuntimeKeys.has(runtimeKey));
}

function normalizeRuntimeKey(adapterType: string): RuntimeKey | null {
  switch (adapterType.trim().toLowerCase()) {
    case "codex":
    case "claude-code":
    case "gemini":
    case "ollama":
      return adapterType.trim().toLowerCase() as RuntimeKey;
    default:
      return null;
  }
}

async function checkRuntime(runtimeKey: RuntimeKey): Promise<RuntimeReadiness> {
  switch (runtimeKey) {
    case "codex":
      return checkCliRuntime("codex", "Codex", ["--version"], "Open a terminal on this server and run `codex login`, then refresh this check.", ["login", "status"]);
    case "claude-code":
      return checkCliRuntime("claude", "Claude Code", ["--version"], "Open a terminal on this server and run `claude login`, then refresh this check.");
    case "gemini":
      return checkCliRuntime("gemini", "Gemini CLI", ["--version"], "Open a terminal on this server and sign in to Gemini CLI, then refresh this check.");
    case "ollama":
      return checkOllamaRuntime();
  }
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
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, {
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
      detail: `Ollama is not reachable at ${OLLAMA_ENDPOINT}. ${sanitizeError(err)}`,
      nextStep: "Install/start Ollama on the HiveWright server, then run setup health again.",
    };
  }
}
