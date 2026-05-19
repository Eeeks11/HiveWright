export type SkillSecurityScanVerdict = "allow" | "warn" | "block";

export interface SkillSecurityFinding {
  verdict: SkillSecurityScanVerdict;
  rule: string;
  message: string;
}

export interface SkillSecurityScanResult {
  verdict: SkillSecurityScanVerdict;
  findings: SkillSecurityFinding[];
}

const BLOCK_PATTERNS: Array<{ rule: string; pattern: RegExp; message: string }> = [
  {
    rule: "credential_exfiltration",
    pattern: /\b(?:print|echo|cat|dump|send|upload|exfiltrate)\b[^\n]*(?:api[\s_-]?key|token|secret|password|credential|\.env|ENCRYPTION_KEY)/i,
    message: "Skill appears to instruct agents to reveal, dump, send, or upload credentials/secrets.",
  },
  {
    rule: "prompt_override",
    pattern: /\b(?:ignore|bypass|override|disable)\b[^\n]*(?:system|developer|hivewright|safety|guardrail|policy|instructions)/i,
    message: "Skill attempts to override higher-priority HiveWright/system instructions or guardrails.",
  },
  {
    rule: "destructive_shell",
    pattern: /\b(?:rm\s+-rf\s+\/?|mkfs\.|dd\s+if=|chmod\s+-R\s+777|chown\s+-R\s+[^\n]*\/)/i,
    message: "Skill contains destructive shell instructions that are not safe as reusable agent guidance.",
  },
  {
    rule: "persistence_or_remote_code",
    pattern: /\b(?:curl|wget)\b[^\n|]*(?:\|\s*(?:bash|sh)|>\s*\/tmp\/|&&\s*(?:bash|sh))|\b(?:crontab|systemctl\s+enable|launchctl|rc\.local)\b/i,
    message: "Skill includes remote-code execution or persistence instructions.",
  },
];

const WARN_PATTERNS: Array<{ rule: string; pattern: RegExp; message: string }> = [
  {
    rule: "network_tool_use",
    pattern: /\b(?:curl|wget|scp|rsync|ssh|nc|netcat)\b/i,
    message: "Skill references network-capable tools; review scope and provenance before publication.",
  },
  {
    rule: "package_install",
    pattern: /\b(?:npm\s+i|npm\s+install|pip\s+install|uv\s+pip\s+install|apt(?:-get)?\s+install|brew\s+install)\b/i,
    message: "Skill asks agents to install packages; ensure this is intentional and governed.",
  },
  {
    rule: "secret_handling",
    pattern: /\b(?:api[\s_-]?key|token|secret|password|credential|\.env)\b/i,
    message: "Skill mentions secrets or credentials; confirm it does not expose or request sensitive values.",
  },
  {
    rule: "privileged_tools",
    pattern: /\b(?:sudo|docker\s+run|kubectl|gh\s+secret|vercel\s+env)\b/i,
    message: "Skill references privileged tooling; review before granting broad reuse.",
  },
];

function strongest(a: SkillSecurityScanVerdict, b: SkillSecurityScanVerdict): SkillSecurityScanVerdict {
  const rank: Record<SkillSecurityScanVerdict, number> = { allow: 0, warn: 1, block: 2 };
  return rank[b] > rank[a] ? b : a;
}

export function scanSkillContent(content: string): SkillSecurityScanResult {
  const findings: SkillSecurityFinding[] = [];
  let verdict: SkillSecurityScanVerdict = "allow";

  for (const rule of BLOCK_PATTERNS) {
    if (rule.pattern.test(content)) {
      findings.push({ verdict: "block", rule: rule.rule, message: rule.message });
      verdict = "block";
    }
  }

  for (const rule of WARN_PATTERNS) {
    if (rule.pattern.test(content)) {
      findings.push({ verdict: "warn", rule: rule.rule, message: rule.message });
      verdict = strongest(verdict, "warn");
    }
  }

  return { verdict, findings };
}
