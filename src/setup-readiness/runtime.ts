import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeError } from "@/memory/local-embedding-setup";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 5_000;
const OLLAMA_TIMEOUT_MS = 5_000;
const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";

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
  detail: string;
  nextStep: string;
};

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
): SetupRuntimeReadinessWarning[] {
  return Object.entries(snapshot.runtimes)
    .filter((entry): entry is [string, RuntimeReadiness & { status: Exclude<RuntimeStatus, "ready"> }] => entry[1].status !== "ready")
    .map(([source, runtime]) => ({
      source,
      label: runtime.label,
      status: runtime.status,
      detail: runtime.detail,
      nextStep: runtime.nextStep,
    }));
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
