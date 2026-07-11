import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import {
  hashOwnerBootstrapToken,
  OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH,
  OWNER_BOOTSTRAP_LOCK_KEY,
} from "./owner-bootstrap";

export const OWNER_SETUP_TOKEN_ENV = "HIVEWRIGHT_OWNER_SETUP_TOKEN";

function assertSafeSecretsFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Runtime secrets path must be a regular file");
  }
}

function replaceSecret(contents: string, value: string | null): string {
  const linePattern = new RegExp(`^${OWNER_SETUP_TOKEN_ENV}=.*(?:\\n|$)`, "gm");
  const withoutToken = contents.replace(linePattern, "");
  if (value === null) return withoutToken;
  const prefix = withoutToken.length > 0 && !withoutToken.endsWith("\n") ? "\n" : "";
  return `${withoutToken}${prefix}${OWNER_SETUP_TOKEN_ENV}=${value}\n`;
}

function secureExistingActiveSecret(filePath: string, expectedHash: string): void {
  assertSafeSecretsFile(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error("Active owner setup requires the local runtime secret");
  }
  const contents = fs.readFileSync(filePath, "utf8");
  const pattern = new RegExp(`^${OWNER_SETUP_TOKEN_ENV}=([A-Za-z0-9_-]{43})$`, "m");
  const token = contents.match(pattern)?.[1];
  if (!token || hashOwnerBootstrapToken(token) !== expectedHash) {
    throw new Error("Active owner setup requires a valid local runtime secret");
  }
  fs.chmodSync(filePath, 0o600);
}

function writeSecretsFile(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  assertSafeSecretsFile(filePath);
  const temporary = `${filePath}.owner-bootstrap-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

export function removeOwnerSetupTokenFromSecrets(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  assertSafeSecretsFile(filePath);
  const contents = fs.readFileSync(filePath, "utf8");
  const updated = replaceSecret(contents, null);
  if (updated === contents) {
    fs.chmodSync(filePath, 0o600);
    return false;
  }
  writeSecretsFile(filePath, updated);
  return true;
}

export function runtimeSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HIVEWRIGHT_SECRETS_FILE
    ?? path.join(env.HIVEWRIGHT_RUNTIME_ROOT ?? path.join(process.env.HOME ?? ".", ".hivewright"), "secrets.env");
}

export async function provisionOwnerBootstrap(
  sql: Sql,
  secretsFile = runtimeSecretsPath(),
): Promise<"provisioned" | "active" | "disabled"> {
  let removeTokenAfterFailure = false;
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${OWNER_BOOTSTRAP_LOCK_KEY}))`;
      const [users] = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM users) AS exists
      `;
      const [state] = await tx<{ consumedAt: Date | null; tokenHash: string }[]>`
        SELECT consumed_at AS "consumedAt", token_hash AS "tokenHash"
        FROM owner_bootstrap_state
        WHERE id = true FOR UPDATE
      `;
      if (users?.exists) {
        removeTokenAfterFailure = true;
        if (!state) {
          await tx`
            INSERT INTO owner_bootstrap_state (id, token_hash, consumed_at)
            VALUES (true, ${OWNER_BOOTSTRAP_DISABLED_TOKEN_HASH}, NOW())
          `;
        } else if (!state.consumedAt) {
          await tx`
            UPDATE owner_bootstrap_state SET consumed_at = NOW()
            WHERE id = true AND consumed_at IS NULL
          `;
        }
        return { status: "disabled" as const };
      }
      if (state) {
        return state.consumedAt
          ? { status: "disabled" as const }
          : { status: "active" as const, tokenHash: state.tokenHash };
      }

      const token = randomBytes(32).toString("base64url");
      const current = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile, "utf8") : "";
      writeSecretsFile(secretsFile, replaceSecret(current, token));
      removeTokenAfterFailure = true;
      await tx`
        INSERT INTO owner_bootstrap_state (id, token_hash)
        VALUES (true, ${hashOwnerBootstrapToken(token)})
      `;
      return { status: "provisioned" as const };
    });
    const normalized = result.status;
    if (normalized === "disabled") removeOwnerSetupTokenFromSecrets(secretsFile);
    if (normalized === "active") secureExistingActiveSecret(secretsFile, result.tokenHash);
    return normalized;
  } catch (error) {
    if (removeTokenAfterFailure) {
      try {
        removeOwnerSetupTokenFromSecrets(secretsFile);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Owner bootstrap provisioning failed and setup token cleanup also failed",
        );
      }
    }
    throw error;
  }
}
