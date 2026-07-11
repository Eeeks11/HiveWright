import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { CodexJsonChunker } from "../../adapters/codex-stream-parser";
import { cleanOwnerVisibleEaReply } from "./output-hygiene";

/**
 * Thin wrapper around the `codex` CLI for EA conversational turns.
 * Not a dispatcher adapter — we don't go through the task-claim flow
 * because the EA is free-form chat, not task execution. Same underlying
 * runtime as the Codex task adapter, just without the task-shaped
 * SessionContext envelope.
 */

export interface RunEaResult {
  success: boolean;
  text: string;
  error?: string;
}

export interface RunEaOptions {
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  onChunk?: (delta: string) => void;
  attachmentPaths?: string[];
  /** Explicit environment variables to pass to Codex in addition to the safe base allowlist. */
  env?: Record<string, string | undefined>;
  /**
   * Codex sandbox mode. Defaults to workspace-write; callers must opt out explicitly.
   */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Codex approval policy. Defaults to on-request; callers must opt out explicitly.
   */
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  /** Runtime home used for Codex config/cache isolation. Defaults under /tmp. */
  runtimeHome?: string;
  /**
   * When aborted, the spawned `codex` subprocess is sent SIGTERM. Used
   * by `runEaStream` to cancel the underlying run when a consumer breaks
   * out of the `for await` loop early (e.g. voice-call hangup mid-reply)
   * so we don't keep burning tokens on output nobody will read.
   */
  signal?: AbortSignal;
}

export function buildEaCommandArgs(
  options: Pick<RunEaOptions, "model" | "sandbox" | "approvalPolicy">,
  cwd: string,
): string[] {
  const model = normalizeEaModel(options.model);
  const args = [
    "exec",
    "--json",
    "--sandbox",
    options.sandbox ?? "workspace-write",
    "--ask-for-approval",
    options.approvalPolicy ?? "on-request",
    "--skip-git-repo-check",
  ];
  if (model) {
    const modelName = model.includes("/") ? model.split("/").at(-1)! : model;
    args.push("-m", modelName);
  }
  args.push("-C", cwd);
  return args;
}

function appendOwnerVisibleText(
  text: string,
  emit: (text: string) => void,
): void {
  const cleaned = cleanOwnerVisibleEaReply(text);
  if (cleaned.removedInternalProcessText.length > 0) {
    console.info("[ea-native] suppressed internal process text from owner-visible reply", {
      removedLines: cleaned.removedInternalProcessText,
    });
  }
  if (cleaned.text.length > 0) emit(cleaned.text);
}

export async function runEa(
  prompt: string,
  options: RunEaOptions = {},
): Promise<RunEaResult> {
  const cwd = ensureRuntimeDirectory(options.cwd ?? process.cwd());
  const runtimeHome = options.runtimeHome ? ensureRuntimeDirectory(options.runtimeHome) : undefined;
  // No --max-turns cap. Owner subscriptions bound cost externally;
  // wall-clock timeout below covers genuine runaway protection.
  const args = buildEaCommandArgs(options, cwd);

  const env = buildEaRuntimeEnv(runtimeHome, options.env);

  return new Promise((resolve) => {
    const proc = spawn("codex", args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // 30-minute default. Discord/dashboard/voice EA turns should route
      // long work into HiveWright roles instead of holding an owner chat
      // subprocess for hours.
      timeout: options.timeoutMs ?? 1_800_000,
    });

    // Wire up AbortSignal -> SIGTERM so `runEaStream` (and any other
    // caller) can cancel the subprocess if they no longer want the
    // output. If already aborted, fire once synchronously; otherwise
    // register + deregister on close to avoid leaking listeners.
    if (options.signal) {
      if (options.signal.aborted) {
        try { proc.kill("SIGTERM"); } catch {}
      } else {
        const onAbort = () => { try { proc.kill("SIGTERM"); } catch {} };
        options.signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => options.signal?.removeEventListener("abort", onAbort));
      }
    }

    proc.stdin.write(withAttachmentReferences(prompt, options.attachmentPaths ?? []));
    proc.stdin.end();

    const chunker = new CodexJsonChunker();
    let assembled = "";
    let stderr = "";
    const decoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");

    proc.stdout.on("data", (data: Buffer) => {
      const text = decoder.decode(data, { stream: true });
      const { texts } = chunker.feed(text);
      for (const t of texts) {
        appendOwnerVisibleText(t, (cleaned) => {
          assembled += cleaned;
          options.onChunk?.(cleaned);
        });
      }
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += stderrDecoder.decode(data, { stream: true });
    });

    proc.on("close", (code) => {
      // Drain any straggling UTF-8 bytes + unterminated chunker line.
      const tail = decoder.decode();
      if (tail) {
        const { texts } = chunker.feed(tail);
        for (const t of texts) {
          appendOwnerVisibleText(t, (cleaned) => {
            assembled += cleaned;
            options.onChunk?.(cleaned);
          });
        }
      }
      const flushed = chunker.flush();
      for (const t of flushed.texts) {
        appendOwnerVisibleText(t, (cleaned) => {
          assembled += cleaned;
          options.onChunk?.(cleaned);
        });
      }

      if (code !== 0) {
        const result = flushed.result;
        resolve({
          success: false,
          text: assembled,
          error: result?.isError && result.errorMessage
            ? `codex exited ${code}: ${result.errorMessage}`
            : `codex exited ${code}: ${stderr.slice(0, 500)}`,
        });
        return;
      }
      resolve({ success: true, text: assembled });
    });

    proc.on("error", (err) => {
      resolve({ success: false, text: assembled, error: err.message });
    });
  });
}

export function normalizeEaModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  return trimmed || undefined;
}

function ensureRuntimeDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

const BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

function buildEaRuntimeEnv(
  runtimeHome: string | undefined,
  extraEnv: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN;
  if (internalServiceToken !== undefined) {
    // EA prompts intentionally reference this variable rather than embedding
    // the secret. Pass only this explicit service credential through; do not
    // inherit arbitrary dispatcher/model/provider secrets.
    env.INTERNAL_SERVICE_TOKEN = internalServiceToken;
  }
  if (runtimeHome) {
    env.HOME = runtimeHome;
    env.XDG_CONFIG_HOME = path.join(runtimeHome, ".config");
    env.XDG_CACHE_HOME = path.join(runtimeHome, ".cache");
    env.XDG_DATA_HOME = path.join(runtimeHome, ".local", "share");
    env.CODEX_HOME = prepareIsolatedCodexHome(runtimeHome);
  }
  env.TMPDIR = process.env.TMPDIR ?? os.tmpdir();
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}


function prepareIsolatedCodexHome(runtimeHome: string): string {
  const codexHome = path.join(runtimeHome, ".codex");
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });

  const sourceCodexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : process.env.HOME
      ? path.join(process.env.HOME, ".codex")
      : undefined;
  if (!sourceCodexHome) return codexHome;

  const sourceAuth = path.join(sourceCodexHome, "auth.json");
  const destAuth = path.join(codexHome, "auth.json");
  if (path.resolve(sourceAuth) === path.resolve(destAuth)) return codexHome;
  try {
    if (fs.existsSync(sourceAuth) && !fs.existsSync(destAuth)) {
      fs.symlinkSync(sourceAuth, destAuth);
    }
  } catch (err) {
    console.warn("[ea-native] could not link Codex auth into isolated runtime home", err);
  }
  return codexHome;
}

function withAttachmentReferences(prompt: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) return prompt;
  const refs = attachmentPaths.map((attachmentPath) => `@${attachmentPath}`).join("\n");
  return `${prompt}\n\n## Attached file references\n${refs}`;
}

/**
 * Streaming variant of `runEa`. Yields text deltas as they're emitted by
 * the underlying Codex CLI so voice callers can pipe chunks straight
 * into TTS without waiting for the whole turn to finish. Built on top of
 * `runEa`'s `onChunk` callback via a small async queue — chunks are
 * pushed in as they arrive and pulled out in order by the generator.
 *
 * If the underlying run fails (non-zero exit or spawn error), the error
 * is thrown from the generator once the run settles. Chunks already
 * flushed before the failure are still yielded first — callers can
 * choose whether to speak them or discard.
 */
export async function* runEaStream(
  prompt: string,
  options: RunEaOptions = {},
): AsyncGenerator<string> {
  // Local controller so we can cancel the subprocess in our `finally`
  // — fires on normal completion, thrown errors, AND early `break` /
  // `.return()` by the consumer (voice hangup mid-reply). Without this
  // the `codex` CLI keeps running and burning tokens on text nobody
  // reads.
  const controller = new AbortController();
  const merged: RunEaOptions = {
    ...options,
    signal: combineSignals(options.signal, controller.signal),
  };

  const queue: string[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;

  const notify = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const task = runEa(prompt, {
    ...merged,
    onChunk: (delta) => {
      queue.push(delta);
      options.onChunk?.(delta);
      notify();
    },
  })
    .then((result) => {
      if (!result.success) {
        error = new Error(result.error ?? "ea stream failed");
      }
    })
    .catch((err) => {
      error = err instanceof Error ? err : new Error(String(err));
    })
    .finally(() => {
      done = true;
      notify();
    });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) {
        // Ensure the underlying promise has fully settled (so `error` is
        // set if the run failed) and propagate any error to the caller.
        await task;
        if (error) throw error;
        return;
      }
      await new Promise<void>((r) => (resolveNext = r));
    }
  } finally {
    // Cancels the subprocess if the caller break'd out early. No-op if
    // the run already completed normally.
    controller.abort();
  }
}

/**
 * Combine an optional external signal with an always-present internal
 * signal. Uses `AbortSignal.any` (Node 20+). Returns the internal signal
 * alone when no external signal is provided.
 */
function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (!external) return internal;
  return AbortSignal.any([external, internal]);
}
