import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_TIMEOUT_MS = 15_000;
const PULL_TIMEOUT_MS = 120_000;

export const DEFAULT_LOCAL_EMBEDDING = {
  provider: "ollama" as const,
  modelName: "nomic-embed-text-v2-moe:latest",
  dimension: 768,
  endpoint: "http://localhost:11434",
};

export interface LocalEmbeddingStatus {
  platform: NodeJS.Platform;
  endpoint: string;
  ollamaReachable: boolean;
  installedModels: string[];
  modelName: string;
  modelInstalled: boolean;
  embeddingTest: "not_run" | "passed" | "failed";
  error: string | null;
}

export interface LocalEmbeddingInstallStep {
  label: string;
  command?: string;
  url?: string;
  requiresConfirmation?: boolean;
}

export interface LocalEmbeddingInstallPlan {
  platform: NodeJS.Platform;
  recommendedMode: "auto" | "manual";
  autoAvailable: boolean;
  autoRequiresAdmin: boolean;
  autoSteps: Array<LocalEmbeddingInstallStep & { requiresConfirmation: boolean }>;
  manualSteps: LocalEmbeddingInstallStep[];
  warnings: string[];
}

type ExecFn = (file: string, args: string[], options?: { timeout?: number }) => Promise<unknown>;

interface ServiceOptions {
  platform?: NodeJS.Platform;
  fetchFn?: typeof fetch;
  exec?: ExecFn;
}

export async function detectLocalEmbeddingStatus(options: ServiceOptions = {}): Promise<LocalEmbeddingStatus> {
  const platform = options.platform ?? process.platform;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const base = DEFAULT_LOCAL_EMBEDDING.endpoint;
  try {
    const res = await fetchFn(`${base}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return baseStatus(platform, false, [], "not_run", `Ollama tags endpoint returned HTTP ${res.status}`);
    }
    const body = await res.json().catch(() => ({}));
    const models = Array.isArray(body.models)
      ? body.models.map((item: unknown) => extractModelName(item)).filter((value: string | null): value is string => Boolean(value))
      : [];
    return baseStatus(
      platform,
      true,
      models,
      "not_run",
      null,
    );
  } catch (err) {
    return baseStatus(platform, false, [], "not_run", `Ollama is not reachable at ${base}. ${sanitizeError(err)}`);
  }
}

export async function testLocalEmbedding(options: ServiceOptions = {}): Promise<LocalEmbeddingStatus> {
  const platform = options.platform ?? process.platform;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const base = DEFAULT_LOCAL_EMBEDDING.endpoint;
  try {
    const res = await fetchFn(`${base}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_LOCAL_EMBEDDING.modelName,
        input: "HiveWright local memory setup test",
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      return baseStatus(platform, true, [DEFAULT_LOCAL_EMBEDDING.modelName], "failed", `Embedding test returned HTTP ${res.status}`);
    }
    const body = await res.json().catch(() => ({}));
    const vectors = Array.isArray(body.embeddings)
      ? body.embeddings
      : Array.isArray(body.embedding)
        ? [body.embedding]
        : [];
    const vector = vectors[0];
    if (vectors.length !== 1 || !Array.isArray(vector)) {
      return baseStatus(platform, true, [DEFAULT_LOCAL_EMBEDDING.modelName], "failed", "Embedding test expected exactly one vector");
    }
    if (vector.length !== DEFAULT_LOCAL_EMBEDDING.dimension) {
      return baseStatus(platform, true, [DEFAULT_LOCAL_EMBEDDING.modelName], "failed", `Embedding test expected 768 dimensions but received ${vector.length}`);
    }
    return baseStatus(platform, true, [DEFAULT_LOCAL_EMBEDDING.modelName], "passed", null);
  } catch (err) {
    return baseStatus(platform, false, [], "failed", `Embedding test failed. ${sanitizeError(err)}`);
  }
}

export async function pullDefaultLocalEmbeddingModel(options: ServiceOptions & { modelName?: string } = {}): Promise<{ ok: true; modelName: string }> {
  const modelName = options.modelName ?? DEFAULT_LOCAL_EMBEDDING.modelName;
  if (modelName !== DEFAULT_LOCAL_EMBEDDING.modelName) {
    throw new Error("Unsupported local embedding model; only the HiveWright default is allowlisted");
  }
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  try {
    const res = await fetchFn(`${DEFAULT_LOCAL_EMBEDDING.endpoint}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_LOCAL_EMBEDDING.modelName, stream: false }),
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Ollama pull returned HTTP ${res.status}`);
    }
    return { ok: true, modelName };
  } catch (err) {
    throw new Error(`Failed to pull local embedding model. ${sanitizeError(err)}`);
  }
}

export function getLocalEmbeddingInstallPlan(platform: NodeJS.Platform = process.platform): LocalEmbeddingInstallPlan {
  const pullCommand = `ollama pull ${DEFAULT_LOCAL_EMBEDDING.modelName}`;
  if (platform === "linux") {
    return {
      platform,
      recommendedMode: "auto",
      autoAvailable: true,
      autoRequiresAdmin: true,
      autoSteps: [
        {
          label: "Run the official Ollama Linux installer from ollama.com",
          command: "curl -fsSL https://ollama.com/install.sh | sh",
          requiresConfirmation: true,
        },
      ],
      manualSteps: [
        { label: "Install Ollama using the official installer", command: "curl -fsSL https://ollama.com/install.sh | sh" },
        { label: "Confirm the system Ollama service is running", command: "systemctl status ollama --no-pager || sudo systemctl status ollama --no-pager" },
        { label: "Download HiveWright's default local embedding model", command: pullCommand },
      ],
      warnings: [
        "Automatic setup is opt-in and requires explicit confirmation before running the official installer.",
        "The installer may request administrator privileges; review the command before continuing.",
      ],
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      recommendedMode: "auto",
      autoAvailable: true,
      autoRequiresAdmin: false,
      autoSteps: [
        { label: "Open the official Ollama macOS download page", url: "https://ollama.com/download/mac", requiresConfirmation: true },
      ],
      manualSteps: [
        { label: "Download Ollama for macOS", url: "https://ollama.com/download/mac" },
        { label: "Optional Homebrew install", command: "brew install --cask ollama" },
        { label: "Download HiveWright's default local embedding model", command: pullCommand },
      ],
      warnings: ["Automatic setup opens a fixed official Ollama download source only after confirmation."],
    };
  }
  if (platform === "win32") {
    return {
      platform,
      recommendedMode: "auto",
      autoAvailable: true,
      autoRequiresAdmin: true,
      autoSteps: [
        { label: "Open the official Ollama Windows installer", url: "https://ollama.com/download/windows", requiresConfirmation: true },
      ],
      manualSteps: [
        { label: "Download Ollama for Windows", url: "https://ollama.com/download/windows" },
        { label: "Start Ollama from the Start menu after installation" },
        { label: "Download HiveWright's default local embedding model", command: pullCommand },
      ],
      warnings: ["The Windows installer may show standard Windows/UAC prompts after confirmation."],
    };
  }
  return {
    platform,
    recommendedMode: "manual",
    autoAvailable: false,
    autoRequiresAdmin: false,
    autoSteps: [],
    manualSteps: [
      { label: "Download Ollama from the official site", url: "https://ollama.com/download" },
      { label: "Download HiveWright's default local embedding model", command: pullCommand },
    ],
    warnings: ["Automatic installation is not available on this platform. Use the manual steps."],
  };
}

export async function installOllamaWithConfirmation(
  request: { confirmed?: boolean },
  options: ServiceOptions = {},
): Promise<{ installed: boolean; status: LocalEmbeddingStatus; plan: LocalEmbeddingInstallPlan; message: string }> {
  if (request.confirmed !== true) {
    throw new Error("Explicit confirmation is required before installing Ollama");
  }
  const platform = options.platform ?? process.platform;
  const plan = getLocalEmbeddingInstallPlan(platform);
  const before = await detectLocalEmbeddingStatus(options);
  if (before.ollamaReachable) {
    return { installed: false, status: before, plan, message: "Ollama is already reachable; installer was not run." };
  }
  if (!plan.autoAvailable) {
    return { installed: false, status: before, plan, message: "Automatic Ollama installation is not available on this platform." };
  }

  const exec = options.exec ?? defaultExec;
  try {
    await runAllowlistedInstallAction(platform, exec);
  } catch (err) {
    const status = await detectLocalEmbeddingStatus(options);
    return { installed: false, status: { ...status, error: `Installer action failed. ${sanitizeError(err)}` }, plan, message: "Installer action failed." };
  }
  const status = await detectLocalEmbeddingStatus(options);
  return { installed: true, status, plan, message: "Ollama installer action completed; local status was re-checked." };
}

function baseStatus(
  platform: NodeJS.Platform,
  ollamaReachable: boolean,
  installedModels: string[],
  embeddingTest: LocalEmbeddingStatus["embeddingTest"],
  error: string | null,
): LocalEmbeddingStatus {
  return {
    platform,
    endpoint: DEFAULT_LOCAL_EMBEDDING.endpoint,
    ollamaReachable,
    installedModels,
    modelName: DEFAULT_LOCAL_EMBEDDING.modelName,
    modelInstalled: installedModels.includes(DEFAULT_LOCAL_EMBEDDING.modelName),
    embeddingTest,
    error,
  };
}

function extractModelName(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const value = typeof obj.name === "string" ? obj.name : typeof obj.model === "string" ? obj.model : null;
  return value;
}

export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "Unknown error");
  return raw
    .replace(/[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*[^\s]+/gi, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

async function defaultExec(file: string, args: string[], options?: { timeout?: number }): Promise<unknown> {
  return execFileAsync(file, args, { timeout: options?.timeout ?? 120_000 });
}

async function assertLinuxInstallerCanUsePrivilege(exec: ExecFn): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return;
  }
  try {
    await exec("sudo", ["-n", "true"], { timeout: 5_000 });
  } catch {
    throw new Error(
      "Linux automatic install requires root or passwordless sudo because the web process cannot show an interactive password prompt. Use the manual terminal install steps instead.",
    );
  }
}

async function runAllowlistedInstallAction(platform: NodeJS.Platform, exec: ExecFn): Promise<void> {
  if (platform === "linux") {
    await assertLinuxInstallerCanUsePrivilege(exec);
    await exec("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { timeout: 120_000 });
    return;
  }
  if (platform === "darwin") {
    await exec("open", ["https://ollama.com/download/mac"], { timeout: 30_000 });
    return;
  }
  if (platform === "win32") {
    await exec("powershell.exe", ["-NoProfile", "-Command", "Start-Process", "https://ollama.com/download/windows"], { timeout: 30_000 });
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
