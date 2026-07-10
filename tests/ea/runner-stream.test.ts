import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock the real `child_process.spawn` so we can drive a fake `codex`
// subprocess by hand. Hoisted by vitest above the SUT import below.
vi.mock("child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "child_process";
import { runEa, runEaStream } from "@/ea/native/runner";

const mockSpawn = vi.mocked(spawn) as unknown as Mock;

/**
 * Build a fake ChildProcess wired with real PassThrough streams. `kill`
 * is a spy that synchronously queues a `close` emit so the subprocess
 * promise settles after the abort fires (mirroring real SIGTERM
 * behavior).
 */
function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: Mock;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => {
    queueMicrotask(() => proc.emit("close", 143));
    return true;
  });
  return proc;
}

/**
 * Frame text as one codex JSONL line in the shape the chunker expects.
 */
function textFrame(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runEa", () => {
  it("runs the Codex CLI without forcing a source-code default model", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const run = runEa("test prompt");
    queueMicrotask(() => proc.emit("close", 0));

    await expect(run).resolves.toMatchObject({ success: true });
    const command = mockSpawn.mock.calls[0]?.[0] as string;
    const args = mockSpawn.mock.calls[0]?.[1] as string[];

    expect(command).toBe("codex");
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args).toContain("--ask-for-approval");
    expect(args[args.indexOf("--ask-for-approval") + 1]).toBe("on-request");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("-m");
  });

  it("defaults the Codex cwd to the app process workspace", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const run = runEa("test prompt");
    queueMicrotask(() => proc.emit("close", 0));

    await expect(run).resolves.toMatchObject({ success: true });
    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { cwd: string };
    expect(args[args.indexOf("-C") + 1]).toBe(process.cwd());
    expect(spawnOptions.cwd).toBe(process.cwd());
  });

  it("uses a caller-provided cwd for explicitly isolated Discord workspaces", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    const isolatedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "hivewright-ea-workspace-"));

    const run = runEa("test prompt", { cwd: isolatedWorkspace });
    queueMicrotask(() => proc.emit("close", 0));

    await expect(run).resolves.toMatchObject({ success: true });
    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { cwd: string };
    expect(args[args.indexOf("-C") + 1]).toBe(isolatedWorkspace);
    expect(spawnOptions.cwd).toBe(isolatedWorkspace);
  });

  it("uses a minimal allowlisted environment instead of inheriting dispatcher secrets", async () => {
    const previousInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
    process.env.HIVEWRIGHT_EA_SENTINEL_SECRET = "do-not-pass";
    process.env.INTERNAL_SERVICE_TOKEN = "ea-internal-token";
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    try {
      const run = runEa("test prompt");
      queueMicrotask(() => proc.emit("close", 0));

      await expect(run).resolves.toMatchObject({ success: true });
      const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string | undefined> };
      expect(spawnOptions.env.INTERNAL_SERVICE_TOKEN).toBe("ea-internal-token");
      expect(spawnOptions.env.HIVEWRIGHT_EA_SENTINEL_SECRET).toBeUndefined();
      expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
      expect(spawnOptions.env.OPENAI_BASE_URL).toBeUndefined();
      expect(spawnOptions.env.HOME).toBe(process.env.HOME);
    } finally {
      delete process.env.HIVEWRIGHT_EA_SENTINEL_SECRET;
      if (previousInternalToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
      else process.env.INTERNAL_SERVICE_TOKEN = previousInternalToken;
    }
  });

  it("uses isolated HOME/XDG directories when a caller provides runtimeHome", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const run = runEa("test prompt", { runtimeHome: "/tmp/hivewright-ea-test-home" });
    queueMicrotask(() => proc.emit("close", 0));

    await expect(run).resolves.toMatchObject({ success: true });
    const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string | undefined> };
    expect(spawnOptions.env.HOME).toBe("/tmp/hivewright-ea-test-home");
    expect(spawnOptions.env.XDG_CONFIG_HOME).toBe("/tmp/hivewright-ea-test-home/.config");
    expect(spawnOptions.env.CODEX_HOME).toBe("/tmp/hivewright-ea-test-home/.codex");
  });

  it("links existing Codex OAuth into the isolated runtime home without inheriting the real config home", async () => {
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "hivewright-real-home-"));
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hivewright-runtime-home-"));
    const realCodexHome = path.join(realHome, ".codex");
    fs.mkdirSync(realCodexHome, { recursive: true });
    fs.writeFileSync(path.join(realCodexHome, "auth.json"), "{}\n");
    process.env.HOME = realHome;
    delete process.env.CODEX_HOME;
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    try {
      const run = runEa("test prompt", { runtimeHome });
      queueMicrotask(() => proc.emit("close", 0));

      await expect(run).resolves.toMatchObject({ success: true });
      const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string | undefined> };
      const isolatedCodexHome = path.join(runtimeHome, ".codex");
      const linkedAuth = path.join(isolatedCodexHome, "auth.json");
      expect(spawnOptions.env.HOME).toBe(runtimeHome);
      expect(spawnOptions.env.CODEX_HOME).toBe(isolatedCodexHome);
      expect(fs.lstatSync(linkedAuth).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(linkedAuth)).toBe(path.join(realCodexHome, "auth.json"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  it("passes a configured EA model through to Codex", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const run = runEa("test prompt", { model: "openai-codex/gpt-5.5" });
    queueMicrotask(() => proc.emit("close", 0));

    await expect(run).resolves.toMatchObject({ success: true });
    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.5");
  });

  it("adds attachment prompt references", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    let stdin = "";
    proc.stdin.on("data", (chunk) => {
      stdin += chunk.toString("utf-8");
    });

    const run = runEa("review these", {
      attachmentPaths: [
        "/tmp/hivewright-ea-attachments/dashboard-turn/screen.png",
        "/tmp/hivewright-ea-attachments/dashboard-turn/brief.pdf",
      ],
    });
    queueMicrotask(() => proc.emit("close", 0));

    await expect(run).resolves.toMatchObject({ success: true });
    expect(stdin).toContain("@/tmp/hivewright-ea-attachments/dashboard-turn/screen.png");
    expect(stdin).toContain("@/tmp/hivewright-ea-attachments/dashboard-turn/brief.pdf");
  });

  it("removes leading internal process announcements from owner-visible replies", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const run = runEa("test prompt");
    proc.stdout.write(
      `${textFrame("Using superpowers: using systematic-debugging to trace the issue.\n\nThe failed task has been reopened for QA.")}\n`,
    );
    proc.stdout.end();
    await new Promise((r) => setImmediate(r));
    proc.emit("close", 0);

    await expect(run).resolves.toMatchObject({
      success: true,
      text: "The failed task has been reopened for QA.",
    });
  });
});

describe("runEaStream", () => {
  it("yields chunks in order as the CLI streams them", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const collected: string[] = [];
    const consumed = (async () => {
      for await (const chunk of runEaStream("test prompt")) {
        collected.push(chunk);
      }
    })();

    // Emit three text frames, then close cleanly.
    proc.stdout.write(
      `${textFrame("Hi")}\n${textFrame(" there")}\n${textFrame("!")}\n`,
    );
    proc.stdout.end();
    // Let stdout 'data' handlers flush before emitting close so the
    // chunker has the full buffer queued before the generator's
    // finished path runs.
    await new Promise((r) => setImmediate(r));
    proc.emit("close", 0);

    await consumed;
    expect(collected).toEqual(["Hi", " there", "!"]);
  });

  it("aborts the subprocess when the consumer breaks early", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const gen = runEaStream("test prompt");
    // Kick the generator so its body actually runs (which spawns the
    // subprocess + wires the abort listener). Without this, `.return()`
    // on a never-started async generator short-circuits before the
    // function body executes, so there's nothing to abort.
    const first = gen.next();
    // Emit one chunk so `first` resolves rather than parking on the
    // notify() queue forever.
    proc.stdout.write(`${textFrame("hi")}\n`);
    await first;

    // Now break early — finally-block fires controller.abort().
    await gen.return(undefined);

    // Proof that Fix 1 works end-to-end: the AbortController inside
    // runEaStream fired, the signal listener in runEa called proc.kill,
    // and the fake subprocess received SIGTERM.
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("streams cleaned owner-visible chunks when the CLI includes a workflow banner", async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const collected: string[] = [];
    const consumed = (async () => {
      for await (const chunk of runEaStream("test prompt")) {
        collected.push(chunk);
      }
    })();

    proc.stdout.write(
      `${textFrame("Workflow: systematic debugging\nUsing-superpowers: load the required skill.\n\nI created task ENG-123 for this.")}\n`,
    );
    proc.stdout.end();
    await new Promise((r) => setImmediate(r));
    proc.emit("close", 0);

    await consumed;
    expect(collected).toEqual(["I created task ENG-123 for this."]);
  });
});
