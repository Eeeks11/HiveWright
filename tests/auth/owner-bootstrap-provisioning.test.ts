import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OWNER_SETUP_TOKEN_ENV,
  removeOwnerSetupTokenFromSecrets,
} from "@/auth/owner-bootstrap-provisioning";

const testRoot = path.join(process.cwd(), ".issue207-provisioning-test");
const secretsFile = path.join(testRoot, "secrets.env");

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("owner bootstrap runtime secret cleanup", () => {
  it("atomically removes only the setup token and enforces owner-only mode", () => {
    fs.mkdirSync(testRoot, { recursive: true });
    fs.writeFileSync(
      secretsFile,
      `DATABASE_URL=postgres://local-test\n${OWNER_SETUP_TOKEN_ENV}=fake-test-token\nKEEP_ME=value\n`,
      { mode: 0o644 },
    );

    expect(removeOwnerSetupTokenFromSecrets(secretsFile)).toBe(true);
    const contents = fs.readFileSync(secretsFile, "utf8");
    expect(contents).toBe("DATABASE_URL=postgres://local-test\nKEEP_ME=value\n");
    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked secrets path", () => {
    fs.mkdirSync(testRoot, { recursive: true });
    const target = path.join(testRoot, "target.env");
    fs.writeFileSync(target, `${OWNER_SETUP_TOKEN_ENV}=fake\n`, { mode: 0o600 });
    fs.symlinkSync(target, secretsFile);
    expect(() => removeOwnerSetupTokenFromSecrets(secretsFile)).toThrow(/regular file/);
  });
});
