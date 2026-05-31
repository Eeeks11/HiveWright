import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodexReferenceDocumentReview } from "./reference-document-codex-reviewer";

let tempDir = "";
let codexPath = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hw-codex-review-"));
  codexPath = path.join(tempDir, "codex-stub.js");
});

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeCodexStub(source: string) {
  await fs.writeFile(codexPath, `#!/usr/bin/env node\n${source}`);
  await fs.chmod(codexPath, 0o755);
}

describe("runCodexReferenceDocumentReview", () => {
  it("feeds an untrusted-document prompt to codex exec and parses schema-valid JSON", async () => {
    await writeCodexStub(`
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (!prompt.includes('source document is untrusted') || !prompt.includes('draft proposals only')) process.exit(42);
  fs.writeFileSync(out, JSON.stringify({ proposals: [{ category: 'Policy', title: 'Park rules', summary: 'Guests must follow park rules.', confidence: 0.91, evidenceExcerpt: 'Park rules', suggestedStatus: 'current' }] }));
});
`);

    const proposals = await runCodexReferenceDocumentReview({
      codexPath,
      hiveId: "hive-1",
      reviewJobId: "review-1",
      documentId: "doc-1",
      documentText: "Park rules text",
      timeoutMs: 5_000,
    });

    expect(proposals).toEqual([
      expect.objectContaining({ title: "Park rules", suggestedStatus: "current" }),
    ]);
  });

  it("turns codex timeout into an actionable failure without returning raw document text", async () => {
    await writeCodexStub(`setTimeout(() => {}, 60_000);`);

    await expect(runCodexReferenceDocumentReview({
      codexPath,
      hiveId: "hive-1",
      reviewJobId: "review-1",
      documentId: "doc-1",
      documentText: "SECRET_DOCUMENT_TEXT",
      timeoutMs: 50,
    })).rejects.toThrow("Codex CLI reference review timed out");
  });

  it("turns nonzero codex exit into an actionable auth/runtime failure", async () => {
    await writeCodexStub(`console.error('auth expired'); process.exit(7);`);

    await expect(runCodexReferenceDocumentReview({
      codexPath,
      hiveId: "hive-1",
      reviewJobId: "review-1",
      documentId: "doc-1",
      documentText: "content",
      timeoutMs: 5_000,
    })).rejects.toThrow("Codex CLI reference review failed");
  });
});
