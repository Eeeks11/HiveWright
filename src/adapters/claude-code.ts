import { spawn } from "child_process";
import type { Adapter, AdapterProbeCredential, AdapterResult, AdapterRuntimeHooks, ChunkCallback, ProbeResult, SessionContext } from "./types";
import { StreamJsonChunker } from "./claude-stream-parser";
import { resolveMcps, buildClaudeMcpConfig } from "../tools/mcp-catalog";
import { healthyProbeResult, probeResultFromBoundaryError } from "./probe-classifier";
import { renderSessionPrompt } from "./context-renderer";
import { assertNotForbiddenHiveWrightWorkspace } from "../dispatcher/workspace-policy";
import { buildAgentEnvironment } from "../security/agent-environment";

export function resolveClaudeCodeWorkspace(ctx: SessionContext): string | null {
  if (ctx.worktreeContext?.isolationStatus === "active" && ctx.worktreeContext.effectiveWorkspace) {
    return ctx.worktreeContext.effectiveWorkspace;
  }
  return ctx.projectWorkspace;
}

export class ClaudeCodeAdapter implements Adapter {
  supportsPersistence = false;

  async probe(modelId: string, credential: AdapterProbeCredential): Promise<ProbeResult> {
    // Probe the CLI auth path the dispatcher actually uses to spawn agents,
    // not the raw Anthropic Messages API. Claude Code authenticates via its
    // own OAuth (Pro/Max subscription), so a working spawn doesn't need
    // ANTHROPIC_API_KEY — and a probe that demands one false-fails every
    // subscription-only deployment.
    const startedAt = Date.now();
    const modelName = modelId.includes("/") ? modelId.split("/").at(-1)! : modelId;
    const args = ["--print", "--model", modelName];

    return new Promise((resolve) => {
      const proc = spawn("claude", args, {
        cwd: process.cwd(),
        env: buildAgentEnvironment({
          scope: { kind: "probe", adapter: "claude-code", model: modelName },
          credentials: credential.secrets,
          nativeProviderState: [".claude", ".claude.json"],
        }),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf-8"); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf-8"); });
      proc.stdin.write("Health probe. Reply with ok.");
      proc.stdin.end();

      proc.on("close", (code) => {
        const latencyMs = Date.now() - startedAt;
        if (code === 0) {
          resolve(healthyProbeResult({ latencyMs, costEstimateUsd: 0 }));
          return;
        }
        resolve(probeResultFromBoundaryError({
          code: code === 143 ? "timeout" : undefined,
          stderr,
          stdout,
          latencyMs,
        }));
      });

      proc.on("error", (err) => {
        resolve(probeResultFromBoundaryError({
          message: err.message,
          latencyMs: Date.now() - startedAt,
        }));
      });
    });
  }

  translate(ctx: SessionContext): string {
    const workspace = resolveClaudeCodeWorkspace(ctx);
    return renderSessionPrompt(ctx, { workspace });
  }

  buildCommand(ctx: SessionContext): string[] {
    const modelName = ctx.model.includes("/") ? ctx.model.split("/")[1] : ctx.model;
    const args = [
      "--print",
      "--permission-mode", "bypassPermissions",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", modelName,
      // No --max-turns cap. Owner ships Anthropic + ChatGPT subscriptions
      // so per-token cost is bounded externally; arbitrary turn caps were
      // forcing premature task decomposition on real multi-file work.
      // The wall-clock cap below + the dispatcher's 5-min heartbeat
      // watchdog cover runaway-loop protection.
    ];

    // Per-role MCP/tool scoping. When toolsConfig is set on the role, we inject
    // ONLY the MCPs the role has been granted (--strict-mcp-config) and
    // optionally narrow the built-in toolset. Roles without toolsConfig keep
    // claude-code's global config — preserves backwards compat.
    if (ctx.toolsConfig) {
      const mcpEntries = resolveMcps(ctx.toolsConfig.mcps);
      if (mcpEntries.length > 0) {
        const mcpJson = JSON.stringify(buildClaudeMcpConfig(mcpEntries));
        args.push("--mcp-config", mcpJson);
        args.push("--strict-mcp-config");
      } else if (ctx.toolsConfig.mcps !== undefined) {
        // Empty list explicitly = NO MCPs at all (lock the role down).
        args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
        args.push("--strict-mcp-config");
      }
      if (ctx.toolsConfig.allowedTools) {
        if (ctx.toolsConfig.allowedTools.length === 0) {
          throw new Error(
            "Claude Code allowedTools was explicitly narrowed to zero tools; refusing to fail open to default built-in permissions.",
          );
        }
        const invalidAllowedTool = ctx.toolsConfig.allowedTools.find((tool) => tool.trim().toLowerCase() === "skill");
        if (invalidAllowedTool) {
          throw new Error(
            'Claude Code allowedTools must not contain "Skill"; migrate role skills to explicit `skills: [...]` entries instead.',
          );
        }
        args.push("--allowed-tools", ctx.toolsConfig.allowedTools.join(","));
      }
    }

    return args;
  }

  async execute(ctx: SessionContext, onChunk?: ChunkCallback, hooks?: AdapterRuntimeHooks): Promise<AdapterResult> {
    const prompt = this.translate(ctx);
    const args = this.buildCommand(ctx);
    const workspace = resolveClaudeCodeWorkspace(ctx);
    if (workspace) assertNotForbiddenHiveWrightWorkspace(workspace);

    return new Promise((resolve) => {
      const proc = spawn("claude", args, {
        cwd: workspace || process.cwd(),
        env: buildAgentEnvironment({
          scope: { kind: "task", adapter: "claude-code", taskId: ctx.task.id, hiveId: ctx.task.hiveId },
          credentials: ctx.credentials,
          nativeProviderState: [".claude", ".claude.json"],
        }),
        stdio: ["pipe", "pipe", "pipe"],
        // 4-hour wall-clock cap — enables real multi-hour autonomy
        // (Opus 4.7 + Claude Code is benchmarked at ~7-hour runs).
        // Heartbeat watchdog (5 min) is the primary stuck-process gate;
        // this is the absolute backstop for genuine hangs.
        timeout: 14_400_000,
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      const chunker = new StreamJsonChunker();
      let rawStdout = "";
      let stderr = "";
      const chunkPromises: Promise<void>[] = [];
      let guardInterrupted = false;
      let guardInterruptReason: string | null = null;
      let guardKillTimer: NodeJS.Timeout | null = null;

      const interruptIfRequested = () => {
        if (guardInterrupted || !hooks?.shouldInterrupt?.()) return;
        guardInterrupted = true;
        guardInterruptReason = hooks.interruptReason?.() ?? "Runtime guard interrupted execution.";
        try {
          proc.kill("SIGTERM");
          guardKillTimer = setTimeout(() => {
            if (proc.exitCode === null) {
              try { proc.kill("SIGKILL"); } catch { /* process may already be closed */ }
            }
          }, 5_000);
          guardKillTimer.unref?.();
        } catch { /* process may already be closed */ }
      };

      const handleRuntimeEvents = (events: ReturnType<StreamJsonChunker["feed"]>["runtimeEvents"]) => {
        if (!hooks || events.length === 0) return;
        chunkPromises.push((async () => {
          for (const event of events) {
            await hooks.onRuntimeEvent?.(event);
            interruptIfRequested();
            if (guardInterrupted) return;
          }
        })().catch(() => {}));
      };

      // Use streaming TextDecoder to handle multi-byte UTF-8 codepoints
      // that may straddle data event boundaries
      const decoder = new TextDecoder("utf-8");

      proc.stdout.on("data", (data: Buffer) => {
        const text = decoder.decode(data, { stream: true });
        rawStdout += text;
        const { texts, runtimeEvents } = chunker.feed(text);
        handleRuntimeEvents(runtimeEvents);
        if (onChunk && texts.length > 0) {
          for (const t of texts) {
            chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
          }
        }
      });

      const stderrDecoder = new TextDecoder("utf-8");
      proc.stderr.on("data", (data: Buffer) => {
        const text = stderrDecoder.decode(data, { stream: true });
        stderr += text;
        if (onChunk) {
          chunkPromises.push(onChunk({ text, type: "stderr" }).catch(() => {}));
        }
      });

      proc.on("close", async (code) => {
        if (guardKillTimer) clearTimeout(guardKillTimer);
        // Flush any final bytes still buffered in the streaming decoder
        // (multi-byte UTF-8 codepoint at the very end of the stream).
        const finalText = decoder.decode();
        if (finalText) {
          rawStdout += finalText;
          const { texts, runtimeEvents } = chunker.feed(finalText);
          handleRuntimeEvents(runtimeEvents);
          if (onChunk && texts.length > 0) {
            for (const t of texts) {
              chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
            }
          }
        }
        // Drain any unterminated final line. flush() also returns the
        // captured result envelope, if any was seen during streaming.
        const tail = chunker.flush();
        handleRuntimeEvents(tail.runtimeEvents);
        if (onChunk && tail.texts.length > 0) {
          for (const t of tail.texts) {
            chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
          }
        }
        await Promise.allSettled(chunkPromises);

        const result = tail.result;

        if (guardInterrupted) {
          resolve({
            success: false,
            output: stderr || rawStdout,
            failureReason: guardInterruptReason ?? "Runtime guard interrupted execution.",
            failureKind: "guard_interrupted",
          });
          return;
        }

        if (code !== 0) {
          // SIGTERM timeout: same handling as before.
          if (code === 143 && (!stderr || stderr.trim() === "")) {
            resolve({
              success: false,
              output: stderr || rawStdout,
              failureReason:
                "Execution slice exceeded adapter timeout (30 minutes). Task likely needs decomposition into smaller tasks or checkpointed implementation.",
              failureKind: "execution_slice_exceeded",
            });
            return;
          }
          if (result?.isError && result.errorSubtype === "error_max_turns") {
            resolve({
              success: false,
              output: result.result,
              failureReason:
                "Reached maximum turn limit. Task likely needs decomposition into smaller tasks or a checkpointed approach.",
              failureKind: "execution_slice_exceeded",
            });
            return;
          }
          // Surface the API/auth error message embedded in the result envelope —
          // claude exits 1 silently on auth failures (Invalid API key, expired
          // OAuth, billing issue), with the human-readable cause only inside
          // the result.result text. Without this, every dev-agent task looks
          // like a mysterious "(no error detail)" failure.
          if (result?.isError && result.result) {
            resolve({
              success: false,
              output: result.result,
              failureReason: `Claude exited code ${code}: ${result.result.slice(0, 500)}`,
              failureKind: "unknown",
            });
            return;
          }
          resolve({
            success: false,
            output: stderr || rawStdout,
            failureReason: `Process exited with code ${code}: ${stderr.trim() || "(no error detail)"}`,
            failureKind: "unknown",
          });
          return;
        }

        if (result) {
          resolve({
            success: !result.isError,
            output: result.result,
            tokensInput: result.tokensInput,
            freshInputTokens: result.freshInputTokens,
            cachedInputTokens: result.cachedInputTokens,
            cacheCreationTokens: result.cacheCreationTokens,
            cachedInputTokensKnown: result.cachedInputTokensKnown,
            tokensOutput: result.tokensOutput,
            modelUsed: result.modelUsed,
          });
          return;
        }

        // No result envelope seen — degraded fallback.
        resolve({ success: true, output: rawStdout });
      });

      proc.on("error", async (err) => {
        await Promise.allSettled(chunkPromises);
        resolve({
          success: false,
          output: "",
          failureReason: guardInterrupted
            ? (guardInterruptReason ?? "Runtime guard interrupted execution.")
            : `Spawn error: ${err.message}`,
          failureKind: guardInterrupted ? "guard_interrupted" : "spawn_error",
        });
      });
    });
  }
}
