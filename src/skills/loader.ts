import * as fs from "fs";
import * as path from "path";
import type { LoadedSkill, ResolvedSkill, SkillMetadata } from "./types";

const MAX_SKILLS_PER_TASK = 3;

function normalizeToolList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tools = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return tools.length > 0 ? Array.from(new Set(tools)) : null;
}

function parseInlineArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",")
    .map((part) => part.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

export function parseSkillFrontmatter(content: string): { metadata: SkillMetadata; body: string } {
  const open = content.match(/^---\r?\n/);
  if (!open) return { metadata: {}, body: content };
  const close = content.slice(open[0].length).match(/\r?\n---(?:\r?\n|$)/);
  if (!close || close.index === undefined) return { metadata: {}, body: content };
  const end = open[0].length + close.index;
  const bodyStart = end + close[0].length;

  const frontmatter = content.slice(open[0].length, end).split(/\r?\n/);
  const body = content.slice(bodyStart);
  const metadata: SkillMetadata = {};

  for (let i = 0; i < frontmatter.length; i += 1) {
    const line = frontmatter[i] ?? "";
    const match = line.match(/^\s*allowed_tools\s*:\s*(.*)$/);
    if (!match) continue;
    const value = match[1] ?? "";
    const inline = parseInlineArray(value);
    if (inline !== null) {
      metadata.allowedTools = normalizeToolList(inline);
      continue;
    }
    const tools: string[] = [];
    while (i + 1 < frontmatter.length) {
      const next = frontmatter[i + 1] ?? "";
      const listMatch = next.match(/^\s*-\s*['\"]?([^'\"]+)['\"]?\s*$/);
      if (!listMatch) break;
      tools.push(listMatch[1].trim());
      i += 1;
    }
    metadata.allowedTools = normalizeToolList(tools);
  }

  return { metadata, body };
}

function loadSkill(skillMdPath: string, slug: string, tier: LoadedSkill["tier"]): LoadedSkill {
  const raw = fs.readFileSync(skillMdPath, "utf-8");
  const parsed = parseSkillFrontmatter(raw);
  return {
    slug,
    content: parsed.body,
    metadata: parsed.metadata,
    tier,
  };
}

export function loadSystemSkills(libraryPath: string): LoadedSkill[] {
  if (!fs.existsSync(libraryPath)) return [];

  const entries = fs.readdirSync(libraryPath, { withFileTypes: true });
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(libraryPath, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    skills.push(loadSkill(skillMdPath, entry.name, "system"));
  }

  return skills;
}

export function loadHiveSkills(hiveSkillsPath: string): LoadedSkill[] {
  if (!fs.existsSync(hiveSkillsPath)) return [];

  const entries = fs.readdirSync(hiveSkillsPath, { withFileTypes: true });
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(hiveSkillsPath, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    skills.push(loadSkill(skillMdPath, entry.name, "hive"));
  }

  return skills;
}

function skillMapBySlug(allSkills: LoadedSkill[]): Map<string, LoadedSkill> {
  const skillMap = new Map<string, LoadedSkill>();
  for (const skill of allSkills) {
    if (!skillMap.has(skill.slug) || skill.tier === "hive") {
      skillMap.set(skill.slug, skill);
    }
  }
  return skillMap;
}

export function resolveSkillSetForTask(
  allSkills: LoadedSkill[],
  requestedSlugs: string[],
): ResolvedSkill[] {
  const uniqueSlugs = Array.from(new Set(requestedSlugs));
  const skillMap = skillMapBySlug(allSkills);
  const matched: ResolvedSkill[] = [];

  for (const slug of uniqueSlugs) {
    const skill = skillMap.get(slug);
    if (skill) {
      matched.push({
        ...skill,
        rendered: `## Skill: ${skill.slug}\n\n${skill.content}`,
      });
    }
    if (matched.length >= MAX_SKILLS_PER_TASK) break;
  }
  return matched;
}

/**
 * Resolve skills for a task. Hive skills override system skills on name conflict.
 * Returns formatted skill content strings (max 3).
 */
export function resolveSkillsForTask(
  allSkills: LoadedSkill[],
  requestedSlugs: string[],
): string[] {
  return resolveSkillSetForTask(allSkills, requestedSlugs).map((skill) => skill.rendered);
}

export function effectiveToolsForLoadedSkills(
  baseToolsConfig: { mcps?: string[]; allowedTools?: string[] } | null,
  resolvedSkills: ResolvedSkill[],
): { mcps?: string[]; allowedTools?: string[] } | null {
  const skillAllowedTools = resolvedSkills
    .flatMap((skill) => skill.metadata?.allowedTools ?? [])
    .filter(Boolean);
  if (skillAllowedTools.length === 0) return baseToolsConfig;

  const uniqueSkillTools = Array.from(new Set(skillAllowedTools));
  const roleAllowedTools = baseToolsConfig?.allowedTools;
  const narrowedAllowedTools = roleAllowedTools && roleAllowedTools.length > 0
    ? roleAllowedTools.filter((tool) => uniqueSkillTools.includes(tool))
    : [];
  if (narrowedAllowedTools.length === 0) {
    throw new Error(
      `Loaded skill allowed_tools resolved to no permitted built-in tools. Role allowedTools must include at least one of: ${uniqueSkillTools.join(", ")}.`,
    );
  }

  return {
    ...(baseToolsConfig ?? {}),
    allowedTools: narrowedAllowedTools,
  };
}
