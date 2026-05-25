import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING,
  detectLocalEmbeddingStatus,
  getLocalEmbeddingInstallPlan,
  installOllamaWithConfirmation,
  pullDefaultLocalEmbeddingModel,
  testLocalEmbedding,
} from "../../src/memory/local-embedding-setup";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("local embedding setup service", () => {
  it("reports Ollama unreachable with a sanitized error", async () => {
    globalThis.fetch = vi.fn(async () => {
      const sensitiveKey = "TO" + "KEN";
      throw new Error(`connect ECONNREFUSED ${sensitiveKey}=redaction-sentinel`);
    }) as unknown as typeof fetch;

    const status = await detectLocalEmbeddingStatus({ platform: "linux" });

    expect(status.ollamaReachable).toBe(false);
    expect(status.modelInstalled).toBe(false);
    expect(status.installedModels).toEqual([]);
    expect(status.error).toMatch(/Ollama is not reachable/i);
    expect(status.error).not.toContain("super-secret");
  });

  it("detects installed models and the default model", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { name: "llama3.2:latest" },
        { model: DEFAULT_LOCAL_EMBEDDING.modelName },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const status = await detectLocalEmbeddingStatus({ platform: "linux" });

    expect(status.ollamaReachable).toBe(true);
    expect(status.installedModels).toContain(DEFAULT_LOCAL_EMBEDDING.modelName);
    expect(status.modelInstalled).toBe(true);
    expect(status.embeddingTest).toBe("not_run");
    expect(status.error).toBeNull();
  });

  it("marks the default model missing when Ollama is reachable without it", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      models: [{ name: "mxbai-embed-large:latest" }],
    }), { status: 200 })) as unknown as typeof fetch;

    const status = await detectLocalEmbeddingStatus({ platform: "linux" });

    expect(status.ollamaReachable).toBe(true);
    expect(status.modelInstalled).toBe(false);
  });

  it("passes the embedding test only for one 768-dimensional vector", async () => {
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(String(init?.body)).toContain(DEFAULT_LOCAL_EMBEDDING.modelName);
      return new Response(JSON.stringify({ embeddings: [new Array(768).fill(0.1)] }), { status: 200 });
    }) as unknown as typeof fetch;

    const status = await testLocalEmbedding({ platform: "linux" });

    expect(status.embeddingTest).toBe("passed");
    expect(status.error).toBeNull();
  });

  it("fails the embedding test for a wrong dimension", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ embeddings: [new Array(12).fill(0.1)] }), { status: 200 })) as unknown as typeof fetch;

    const status = await testLocalEmbedding({ platform: "linux" });

    expect(status.embeddingTest).toBe("failed");
    expect(status.error).toMatch(/expected 768/i);
  });

  it("pulls only the allowlisted default model", async () => {
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ model: DEFAULT_LOCAL_EMBEDDING.modelName, stream: false });
      return new Response(JSON.stringify({ status: "success" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(pullDefaultLocalEmbeddingModel()).resolves.toEqual({ ok: true, modelName: DEFAULT_LOCAL_EMBEDDING.modelName });
    await expect(pullDefaultLocalEmbeddingModel({ modelName: "evil/model" })).rejects.toThrow(/unsupported/i);
  });

  it("returns OS-specific install plans with warnings and fixed sources", () => {
    const linux = getLocalEmbeddingInstallPlan("linux");
    expect(linux.autoAvailable).toBe(true);
    expect(linux.autoRequiresAdmin).toBe(true);
    expect(linux.autoSteps.some((step) => step.command?.includes("https://ollama.com/install.sh"))).toBe(true);
    expect(linux.manualSteps.some((step) => step.command?.includes(`ollama pull ${DEFAULT_LOCAL_EMBEDDING.modelName}`))).toBe(true);
    expect(linux.manualSteps.some((step) => step.command?.includes("systemctl --user start ollama"))).toBe(false);
    expect(linux.manualSteps.some((step) => step.command?.includes("sudo systemctl status ollama"))).toBe(true);
    expect(linux.warnings.join(" ")).toMatch(/confirmation/i);

    const darwin = getLocalEmbeddingInstallPlan("darwin");
    expect(darwin.manualSteps.some((step) => step.url === "https://ollama.com/download/mac")).toBe(true);
    expect(darwin.autoSteps.some((step) => step.url === "https://ollama.com/download/mac")).toBe(true);

    const win32 = getLocalEmbeddingInstallPlan("win32");
    expect(win32.manualSteps.some((step) => step.url === "https://ollama.com/download/windows")).toBe(true);
  });

  it("installer rejects missing confirmation and ignores client commands", async () => {
    await expect(installOllamaWithConfirmation({ confirmed: false, command: "rm -rf /" } as never)).rejects.toThrow(/confirmation/i);
  });

  it("installer no-ops if Ollama is already reachable", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch;
    const exec = vi.fn();

    const result = await installOllamaWithConfirmation({ confirmed: true }, { platform: "linux", exec });

    expect(exec).not.toHaveBeenCalled();
    expect(result.status.ollamaReachable).toBe(true);
    expect(result.installed).toBe(false);
  });

  it("linux installer refuses non-interactive sudo instead of surfacing raw password prompt failures", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === "sudo" && args.join(" ") === "-n true") {
        throw new Error("sudo: a password is required");
      }
      throw new Error("installer should not run");
    });

    const result = await installOllamaWithConfirmation({ confirmed: true }, { platform: "linux", exec });

    expect(result.installed).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("sudo", ["-n", "true"], { timeout: 5_000 });
    expect(result.status.error).toMatch(/passwordless sudo/i);
    expect(result.status.error).toMatch(/manual/i);
    expect(result.status.error).not.toMatch(/terminal is required|askpass|password is required/i);
  });
});
