import postgres from "postgres";
import { provisionOwnerBootstrap, runtimeSecretsPath } from "../src/auth/owner-bootstrap-provisioning";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  try {
    const result = await provisionOwnerBootstrap(sql, runtimeSecretsPath());
    // Never print the token. The operator reads it directly from the owner-only file.
    console.log(`[owner-bootstrap] ${result}; setup secret value was not displayed`);
  } finally {
    await sql.end();
  }
}

main().catch(() => {
  console.error("[owner-bootstrap] provisioning failed");
  process.exit(1);
});
