import type { Sql } from "postgres";
import { scanSkillContent, type SkillSecurityFinding } from "../skills/security-scanner";

export type RoleToolsConfig = {
  mcps?: string[];
  allowedTools?: string[];
  customRole?: HiveCustomRoleMetadata;
};

export type HiveCustomRoleMetadata = {
  source: "hive-custom";
  hiveId: string;
  baseRoleSlug: string;
};

export type CreateHiveCustomRoleInput = {
  hiveId: string;
  slug: string;
  name: string;
  baseRoleSlug: string;
  instructions: string;
  requestedToolsConfig?: { mcps?: string[]; allowedTools?: string[] } | null;
  requestedSkills?: string[] | null;
};

export type CreateHiveCustomRoleResult = {
  slug: string;
  baseRoleSlug: string;
  hiveId: string;
  securityFindings: SkillSecurityFinding[];
  toolsConfig: RoleToolsConfig | null;
  skills: string[];
};

type BaseRoleRow = {
  slug: string;
  name: string;
  department: string | null;
  type: string;
  delegates_to: string[] | null;
  recommended_model: string | null;
  fallback_model: string | null;
  adapter_type: string;
  fallback_adapter_type: string | null;
  skills: string[] | null;
  tools_config: RoleToolsConfig | string | null;
  role_md: string | null;
  soul_md: string | null;
  tools_md: string | null;
  terminal: boolean;
  concurrency_limit: number;
};

const CUSTOM_ROLE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const SECRET_RE = /(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function uniqueStrings(value: string[] | string | undefined | null): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return Array.from(new Set(parsed.map((item) => String(item).trim()).filter(Boolean))).sort();
}

function isSubset(requested: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return requested.every((item) => allowedSet.has(item));
}

function normalizeRequestedTools(value: CreateHiveCustomRoleInput["requestedToolsConfig"]): { mcps?: string[]; allowedTools?: string[] } | null {
  if (!value) return null;
  const mcps = uniqueStrings(value.mcps);
  const allowedTools = uniqueStrings(value.allowedTools);
  const output: { mcps?: string[]; allowedTools?: string[] } = {};
  if (mcps.length > 0) output.mcps = mcps;
  if (allowedTools.length > 0) output.allowedTools = allowedTools;
  return Object.keys(output).length > 0 ? output : null;
}

function validateNoSecrets(input: CreateHiveCustomRoleInput, findings: SkillSecurityFinding[]) {
  const scannedText = [input.name, input.slug, input.instructions].join("\n\n");
  const scan = scanSkillContent(scannedText);
  findings.push(...scan.findings);
  if (scan.verdict === "block") {
    throw new Error(`Custom role rejected by security scanner: ${scan.findings.map((finding) => finding.rule).join(", ")}`);
  }
  if (scan.findings.some((finding) => finding.rule === "secret_handling") || SECRET_RE.test(scannedText)) {
    throw new Error("Custom role rejected: role text must not contain secrets, tokens, passwords, or credential material.");
  }
}

function normalizeToolsConfig(value: RoleToolsConfig | string | null): RoleToolsConfig | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as RoleToolsConfig;
    } catch {
      return null;
    }
  }
  return value;
}

function resolveToolsConfig(
  rawBaseToolsConfig: RoleToolsConfig | string | null,
  requested: { mcps?: string[]; allowedTools?: string[] } | null,
  metadata: HiveCustomRoleMetadata,
): RoleToolsConfig | null {
  const baseToolsConfig = normalizeToolsConfig(rawBaseToolsConfig);
  const baseMcps = uniqueStrings(baseToolsConfig?.mcps);
  const baseAllowedTools = uniqueStrings(baseToolsConfig?.allowedTools);
  const requestedMcps = uniqueStrings(requested?.mcps);
  const requestedAllowedTools = uniqueStrings(requested?.allowedTools);

  if (requestedMcps.length > 0) {
    if (baseMcps.length === 0 || !isSubset(requestedMcps, baseMcps)) {
      throw new Error("Custom role toolsConfig.mcps must be a subset of the base role MCP grants.");
    }
  }
  if (requestedAllowedTools.length > 0) {
    if (baseAllowedTools.length === 0 || !isSubset(requestedAllowedTools, baseAllowedTools)) {
      throw new Error("Custom role toolsConfig.allowedTools must be a subset of the base role built-in tool grants.");
    }
  }

  const inherited: RoleToolsConfig | null = baseToolsConfig
    ? {
        ...(baseMcps.length > 0 ? { mcps: baseMcps } : {}),
        ...(baseAllowedTools.length > 0 ? { allowedTools: baseAllowedTools } : {}),
      }
    : null;

  const narrowed = requested
    ? {
        ...(requestedMcps.length > 0 ? { mcps: requestedMcps } : inherited?.mcps ? { mcps: inherited.mcps } : {}),
        ...(requestedAllowedTools.length > 0 ? { allowedTools: requestedAllowedTools } : inherited?.allowedTools ? { allowedTools: inherited.allowedTools } : {}),
      }
    : inherited;

  return narrowed ? { ...narrowed, customRole: metadata } : { customRole: metadata };
}

export function customRoleTemplateSlug(hiveId: string, requestedSlug: string): string {
  return `hive-${hiveId.replace(/-/g, "").slice(0, 12)}-${requestedSlug}`;
}

export async function createHiveCustomRole(
  sql: Sql,
  input: CreateHiveCustomRoleInput,
): Promise<CreateHiveCustomRoleResult> {
  const requestedSlug = input.slug.trim().toLowerCase();
  if (!CUSTOM_ROLE_SLUG_RE.test(requestedSlug)) {
    throw new Error("Custom role slug must be 3-50 chars of lowercase letters, numbers, and hyphens.");
  }
  if (!input.name.trim()) throw new Error("Custom role name is required.");
  if (!input.instructions.trim()) throw new Error("Custom role instructions are required.");

  const findings: SkillSecurityFinding[] = [];
  validateNoSecrets(input, findings);

  const [base] = await sql<BaseRoleRow[]>`
    SELECT slug, name, department, type, delegates_to, recommended_model, fallback_model,
           adapter_type, fallback_adapter_type, skills, tools_config, role_md, soul_md, tools_md,
           terminal, concurrency_limit
    FROM role_templates
    WHERE slug = ${input.baseRoleSlug} AND active = true
  `;
  if (!base) throw new Error(`Base role not found or inactive: ${input.baseRoleSlug}`);
  if (base.type !== "executor") throw new Error("Custom roles must inherit from an active executor base role.");
  if (base.terminal) throw new Error("Custom roles cannot inherit from terminal/system roles.");

  const baseSkills = uniqueStrings(base.skills);
  const requestedSkills = uniqueStrings(input.requestedSkills);
  if (requestedSkills.length > 0 && !isSubset(requestedSkills, baseSkills)) {
    throw new Error("Custom role skills must be a subset of the base role skills.");
  }
  const skills = requestedSkills.length > 0 ? requestedSkills : baseSkills;

  const slug = customRoleTemplateSlug(input.hiveId, requestedSlug);
  const metadata: HiveCustomRoleMetadata = {
    source: "hive-custom",
    hiveId: input.hiveId,
    baseRoleSlug: base.slug,
  };
  const toolsConfig = resolveToolsConfig(base.tools_config, normalizeRequestedTools(input.requestedToolsConfig), metadata);
  const roleMd = [
    base.role_md,
    "## Hive custom role overlay",
    `This is a hive-scoped custom role for hive ${input.hiveId}. It inherits governance from base role ${base.slug}.`,
    input.instructions.trim(),
  ].filter(Boolean).join("\n\n");

  await sql`
    INSERT INTO role_templates (
      slug, name, department, type, delegates_to, recommended_model, fallback_model,
      adapter_type, fallback_adapter_type, skills, tools_config, role_md, soul_md, tools_md,
      terminal, concurrency_limit, owner_pinned, active, updated_at
    ) VALUES (
      ${slug}, ${input.name.trim()}, ${base.department}, ${base.type},      ${sql.json(base.delegates_to ?? [])},
      ${base.recommended_model}, ${base.fallback_model}, ${base.adapter_type}, ${base.fallback_adapter_type},
      ${sql.json(skills)}, ${sql.json(toolsConfig as unknown as Parameters<typeof sql.json>[0])}, ${roleMd}, ${base.soul_md}, ${base.tools_md},
      false, ${base.concurrency_limit}, false, true, now()
    )
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      department = EXCLUDED.department,
      type = EXCLUDED.type,
      delegates_to = EXCLUDED.delegates_to,
      recommended_model = EXCLUDED.recommended_model,
      fallback_model = EXCLUDED.fallback_model,
      adapter_type = EXCLUDED.adapter_type,
      fallback_adapter_type = EXCLUDED.fallback_adapter_type,
      skills = EXCLUDED.skills,
      tools_config = EXCLUDED.tools_config,
      role_md = EXCLUDED.role_md,
      soul_md = EXCLUDED.soul_md,
      tools_md = EXCLUDED.tools_md,
      terminal = EXCLUDED.terminal,
      concurrency_limit = EXCLUDED.concurrency_limit,
      active = true,
      updated_at = now()
  `;

  return {
    slug,
    baseRoleSlug: base.slug,
    hiveId: input.hiveId,
    securityFindings: findings,
    toolsConfig,
    skills,
  };
}

export function parseCustomRoleMetadata(toolsConfig: unknown): HiveCustomRoleMetadata | null {
  if (!toolsConfig || typeof toolsConfig !== "object") return null;
  const customRole = (toolsConfig as { customRole?: unknown }).customRole;
  if (!customRole || typeof customRole !== "object") return null;
  const candidate = customRole as Partial<HiveCustomRoleMetadata>;
  if (candidate.source !== "hive-custom") return null;
  if (!candidate.hiveId || !candidate.baseRoleSlug) return null;
  return {
    source: "hive-custom",
    hiveId: String(candidate.hiveId),
    baseRoleSlug: String(candidate.baseRoleSlug),
  };
}
