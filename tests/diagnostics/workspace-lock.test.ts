import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWorkspace } from "@/diagnostics/checks";

const chmodSupported = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

describe("diagnostics workspace check", () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (!tmp) return;
    fs.chmodSync(tmp, 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it.runIf(chmodSupported)("accepts a locked operational install that is readable/executable but not writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivewright-locked-workspace-"));
    tmp = dir;
    fs.chmodSync(dir, 0o555);

    const status = checkWorkspace(dir, new Date("2026-06-12T00:00:00.000Z"));

    expect(status).toMatchObject({
      id: "app.workspace",
      severity: "ok",
      summary: "Application workspace is readable and executable.",
    });
  });
});
