import { describe, it, expect } from "vitest";
import path from "path";
import {
  effectiveToolsForLoadedSkills,
  loadHiveSkills,
  loadSystemSkills,
  parseSkillFrontmatter,
  resolveSkillsForTask,
  resolveSkillSetForTask,
} from "@/skills/loader";

const SYSTEM_SKILLS_PATH = path.resolve(__dirname, "../../skills-library");

describe("loadSystemSkills", () => {
  it("loads skills from the skills-library directory", () => {
    const skills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    expect(skills.length).toBeGreaterThanOrEqual(2);
    expect(skills.some((s) => s.slug === "blog-writing")).toBe(true);
    expect(skills.some((s) => s.slug === "xero-reconciliation")).toBe(true);
  });

  it("each skill has slug and content", () => {
    const skills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    for (const skill of skills) {
      expect(skill.slug).toBeTruthy();
      expect(skill.content).toBeTruthy();
      expect(skill.content.length).toBeGreaterThan(10);
    }
  });

  it("content toolkit includes the HiveWright product copy guard", () => {
    const allSkills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    const skill = allSkills.find((s) => s.slug === "content-creation-toolkit");
    expect(skill?.content).toContain("HiveWright Product Copy Guard");
    expect(skill?.content).toContain("Do **not** introduce");
    expect(skill?.content).toContain("AI pilot");
    expect(skill?.content).toContain("AI spend budget");
  });
});

describe("loadHiveSkills", () => {
  it("returns empty array when hive skills path does not exist", () => {
    const skills = loadHiveSkills("/nonexistent/path/skills");
    expect(skills).toEqual([]);
  });
});

describe("resolveSkillsForTask", () => {
  it("returns matching skills by slug list", () => {
    const allSkills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    const resolved = resolveSkillsForTask(allSkills, ["blog-writing"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toContain("blog-writing");
  });

  it("returns empty for no matches", () => {
    const allSkills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    const resolved = resolveSkillsForTask(allSkills, ["nonexistent-skill"]);
    expect(resolved).toHaveLength(0);
  });

  it("caps at 3 skills", () => {
    const allSkills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    const resolved = resolveSkillsForTask(allSkills, [
      "blog-writing", "xero-reconciliation", "blog-writing", "xero-reconciliation", "blog-writing",
    ]);
    expect(resolved.length).toBeLessThanOrEqual(3);
  });
});

describe("skill frontmatter metadata", () => {
  it("parses allowed_tools from YAML-like frontmatter", () => {
    const parsed = parseSkillFrontmatter(`---\nallowed_tools:\n  - read_file\n  - web_search\n---\nBody`);
    expect(parsed.body).toBe("Body");
    expect(parsed.metadata.allowedTools).toEqual(["read_file", "web_search"]);
  });

  it("parses allowed_tools from CRLF frontmatter", () => {
    const parsed = parseSkillFrontmatter("---\r\nallowed_tools: [Read, Bash]\r\n---\r\nBody");
    expect(parsed.body).toBe("Body");
    expect(parsed.metadata.allowedTools).toEqual(["Read", "Bash"]);
  });

  it("narrows role allowed tools by loaded skill declarations without granting new tools", () => {
    const allSkills = [{
      slug: "safe-skill",
      tier: "system" as const,
      content: "Body",
      metadata: { allowedTools: ["read_file", "terminal"] },
    }];
    const resolved = resolveSkillSetForTask(allSkills, ["safe-skill"]);
    const narrowed = effectiveToolsForLoadedSkills({ allowedTools: ["read_file", "write_file"], mcps: ["github"] }, resolved);
    expect(narrowed).toEqual({ allowedTools: ["read_file"], mcps: ["github"] });
  });

  it("fails closed when a skill declaration has no overlap with the role baseline", () => {
    expect(() => effectiveToolsForLoadedSkills(null, [{
      slug: "network-skill",
      tier: "system",
      content: "Body",
      metadata: { allowedTools: ["web_search"] },
      rendered: "## Skill: network-skill\n\nBody",
    }])).toThrow(/no permitted built-in tools/i);
  });
});
