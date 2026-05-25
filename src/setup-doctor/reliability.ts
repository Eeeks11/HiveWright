import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  label: string;
  status: DoctorCheckStatus;
  detail?: string;
};

export type DoctorReport = {
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
  markdown: string;
  mutations: string[];
};

export type DoctorRuntime = {
  env: NodeJS.ProcessEnv;
  commandAvailable: (name: string) => boolean;
  npmScriptNames: () => string[];
  dbReachable: () => Promise<{ ok: boolean; detail?: string }>;
  migrationJournalOk: () => Promise<{ ok: boolean; detail?: string }>;
  now?: () => Date;
};

export type SetupGuide = {
  markdown: string;
  mutations: string[];
};

export type EnvTemplateResult = {
  written: boolean;
  path: string;
  mutations: string[];
};

const requiredEnvNames = ["DATABASE_URL", "ENCRYPTION_KEY", "INTERNAL_SERVICE_TOKEN"] as const;

const placeholderEnvTemplate = `# HiveWright local environment template
# Copy to .env.local and fill values locally. Never commit real secrets.
DATABASE_URL=
ENCRYPTION_KEY=
INTERNAL_SERVICE_TOKEN=
# Optional integrations
VOICE_SERVICES_URL=
`;

function redactDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return detail
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://[redacted]")
    .replace(/(password|token|secret|key)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/(password|token|secret|key):\s*([^\s]+)/gi, "$1: [redacted]");
}

function hasScript(scripts: string[], name: string) {
  return scripts.includes(name);
}

function statusRank(status: DoctorCheckStatus) {
  return status === "fail" ? 2 : status === "warn" ? 1 : 0;
}

function summarizeStatus(checks: DoctorCheck[]): DoctorCheckStatus {
  const rank = Math.max(...checks.map((check) => statusRank(check.status)), 0);
  return rank === 2 ? "fail" : rank === 1 ? "warn" : "pass";
}

function renderCheck(check: DoctorCheck) {
  const detail = redactDetail(check.detail);
  const envName = requiredEnvNames.includes(check.label as (typeof requiredEnvNames)[number]);
  const availabilityOnly = [
    "Security scan command",
    "Dispatcher command",
    "Dispatcher readiness command",
    "Budget visibility",
    "Emergency stop visibility",
  ].includes(check.label);

  if (envName || availabilityOnly) {
    const statusSuffix = check.status === "pass" ? "" : ` (${check.status})`;
    return `- ${check.label}: ${detail ?? check.status}${statusSuffix}`;
  }
  return `- ${check.label}: ${check.status}${detail ? ` — ${detail}` : ""}`;
}

export async function buildDoctorReport(runtime: DoctorRuntime): Promise<DoctorReport> {
  const scripts = runtime.npmScriptNames();
  const checks: DoctorCheck[] = [];

  checks.push({
    label: "Node command",
    status: runtime.commandAvailable("node") ? "pass" : "fail",
    detail: runtime.commandAvailable("node") ? "available" : "missing from PATH",
  });
  checks.push({
    label: "npm command",
    status: runtime.commandAvailable("npm") ? "pass" : "fail",
    detail: runtime.commandAvailable("npm") ? "available" : "missing from PATH",
  });

  for (const name of requiredEnvNames) {
    checks.push({
      label: name,
      status: runtime.env[name] ? "pass" : "fail",
      detail: runtime.env[name] ? "set" : "missing",
    });
  }

  const db = await runtime.dbReachable();
  checks.push({
    label: "DB reachability",
    status: db.ok ? "pass" : "fail",
    detail: db.ok ? "reachable" : redactDetail(db.detail) ?? "unreachable",
  });

  const journal = await runtime.migrationJournalOk();
  checks.push({
    label: "Migration journal",
    status: journal.ok ? "pass" : "fail",
    detail: journal.ok ? "ok" : redactDetail(journal.detail) ?? "check failed",
  });

  checks.push({
    label: "Security scan command",
    status: hasScript(scripts, "security:scan") ? "pass" : "fail",
    detail: hasScript(scripts, "security:scan") ? "available" : "missing npm script",
  });
  checks.push({
    label: "Dispatcher command",
    status: hasScript(scripts, "dispatcher") ? "pass" : "fail",
    detail: hasScript(scripts, "dispatcher") ? "available" : "missing npm script",
  });
  checks.push({
    label: "Dispatcher readiness command",
    status: hasScript(scripts, "readiness:dispatcher-health") ? "pass" : "warn",
    detail: hasScript(scripts, "readiness:dispatcher-health") ? "available" : "missing npm script",
  });
  checks.push({
    label: "Budget visibility",
    status: hasScript(scripts, "readiness:ai-budget-profile") ? "pass" : "warn",
    detail: hasScript(scripts, "readiness:ai-budget-profile") ? "available" : "missing npm script",
  });
  checks.push({
    label: "Emergency stop visibility",
    status: hasScript(scripts, "readiness:emergency-stop") ? "pass" : "warn",
    detail: hasScript(scripts, "readiness:emergency-stop") ? "available" : "missing npm script",
  });

  const status = summarizeStatus(checks);
  const timestamp = (runtime.now?.() ?? new Date()).toISOString();
  const markdown = [
    "# HiveWright Doctor",
    "",
    `Status: ${status}`,
    `Ran at: ${timestamp}`,
    "Mode: read-only; no database or env-file mutations are performed.",
    "",
    "## Checks",
    ...checks.map(renderCheck),
    "",
    "## Next commands",
    "- npm run setup",
    "- npm run security:scan",
    "- npm run readiness:dispatcher-health",
  ].join("\n");

  return { status, checks, markdown, mutations: [] };
}

export function buildSetupGuide(input: { writeEnvTemplate: boolean }): SetupGuide {
  const lines = [
    "# HiveWright Guided Setup",
    "",
    "This command is guidance-first. It does not write env files unless `--write-env-template` is passed.",
    "",
    "## Prerequisites",
    "- Node.js and npm available on PATH",
    "- PostgreSQL reachable via DATABASE_URL",
    "- ENCRYPTION_KEY and INTERNAL_SERVICE_TOKEN set in local env/secrets",
    "- Secrets stay local; this guide prints variable names only, never values.",
    "",
    "## Recommended next commands",
    "1. npm run doctor",
    "2. npm run db:migrate:app",
    "3. npm run security:scan",
    "4. npm run readiness:dispatcher-health",
    "5. npm run dispatcher",
  ];
  if (!input.writeEnvTemplate) {
    lines.push("", "Env template not written. Re-run `npm run setup -- --write-env-template` to create `.env.local.example`.");
  }
  return { markdown: lines.join("\n"), mutations: [] };
}

export function writeEnvTemplateIfRequested(input: {
  writeEnvTemplate: boolean;
  targetPath?: string;
}): EnvTemplateResult {
  const targetPath = input.targetPath ?? path.join(process.cwd(), ".env.local.example");
  if (!input.writeEnvTemplate) {
    return { written: false, path: targetPath, mutations: [] };
  }
  if (existsSync(targetPath)) {
    throw new Error(`Env template already exists; refusing to overwrite: ${targetPath}`);
  }
  writeFileSync(targetPath, placeholderEnvTemplate, { encoding: "utf8", mode: 0o600 });
  return { written: true, path: targetPath, mutations: [`wrote ${targetPath}`] };
}
