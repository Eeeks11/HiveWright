type AuditCounts = {
  critical: number;
  high: number;
  moderate: number;
  low: number;
};

export type NpmAuditSummary = {
  counts: AuditCounts;
  rawCounts: AuditCounts;
  countDetail: string;
  blockingDetail: string | null;
  blockingFindingDetails: string[];
  reviewedFindingDetails: string[];
};

type ReviewedAdvisoryMitigation = {
  packageName: string;
  advisoryId: string;
  severity: "high" | "critical";
  vulnerableRange: string;
  nodes: string[];
  effects: string[];
  rationale: string;
};

const reviewedProductionMitigations: ReviewedAdvisoryMitigation[] = [
  {
    packageName: "nodemailer",
    advisoryId: "GHSA-p6gq-j5cr-w38f",
    severity: "high",
    vulnerableRange: "<=9.0.0",
    nodes: ["node_modules/nodemailer"],
    effects: ["@auth/core", "next-auth"],
    rationale:
      "HiveWright keeps nodemailer on the NextAuth/Auth.js compatible ^7 line. " +
      "The patched nodemailer 9.x line conflicts with @auth/core@0.41.2 and next-auth@5.0.0-beta.31 peer constraints, " +
      "and this app does not expose owner-controlled Nodemailer raw message payloads through its runtime source. " +
      "Do not broaden this mitigation without re-reviewing Auth.js mail compatibility and message construction reachability.",
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function severityBlocks(value: unknown): value is "critical" | "high" {
  return value === "critical" || value === "high";
}

function extractAdvisoryId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(/GHSA-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i);
  return match ? match[0] : null;
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").sort()
    : [];
}

function sameStringSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function mitigationForViaEntry(packageName: string, vulnerability: Record<string, unknown>, entry: Record<string, unknown>) {
  const advisoryId = extractAdvisoryId(entry.url);
  if (!advisoryId || !severityBlocks(entry.severity)) return null;

  return reviewedProductionMitigations.find((mitigation) => (
    mitigation.packageName === packageName &&
    mitigation.advisoryId.toLowerCase() === advisoryId.toLowerCase() &&
    mitigation.severity === entry.severity &&
    mitigation.vulnerableRange === entry.range &&
    sameStringSet(mitigation.nodes, sortedStrings(vulnerability.nodes)) &&
    sameStringSet(mitigation.effects, sortedStrings(vulnerability.effects))
  )) ?? null;
}

function summarizeViaEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!isRecord(entry) || !severityBlocks(entry.severity)) return null;

  const title = typeof entry.title === "string" && entry.title.trim()
    ? entry.title.trim()
    : typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : "untitled advisory";
  const advisoryId = extractAdvisoryId(entry.url);

  return advisoryId ? `${title} (${advisoryId})` : title;
}

function summarizeReviewedMitigation(packageName: string, entry: Record<string, unknown>, mitigation: ReviewedAdvisoryMitigation) {
  const title = typeof entry.title === "string" && entry.title.trim()
    ? entry.title.trim()
    : `${packageName} ${mitigation.advisoryId}`;
  return `${packageName}: reviewed mitigation for ${title} (${mitigation.advisoryId}) — ${mitigation.rationale}`;
}

function summarizeVulnerability(name: string, value: unknown) {
  if (!isRecord(value) || !severityBlocks(value.severity)) {
    return { blocking: null, reviewed: [] as string[] };
  }

  const packageName = typeof value.name === "string" && value.name.trim()
    ? value.name.trim()
    : name;
  const reviewed: string[] = [];
  const blockingVia = Array.isArray(value.via)
    ? value.via.flatMap((entry) => {
        if (!isRecord(entry)) {
          const summary = summarizeViaEntry(entry);
          return summary ? [summary] : [];
        }
        const mitigation = mitigationForViaEntry(packageName, value, entry);
        if (mitigation) {
          reviewed.push(summarizeReviewedMitigation(packageName, entry, mitigation));
          return [];
        }
        const summary = summarizeViaEntry(entry);
        return summary ? [summary] : [];
      })
    : [];

  if (blockingVia.length === 0) {
    return { blocking: null, reviewed };
  }

  const detail = blockingVia.join("; ");
  return { blocking: `${packageName}: ${detail}`, reviewed };
}

export function summarizeNpmAuditReport(report: unknown): NpmAuditSummary {
  const parsed = asRecord(report);
  const vulnerabilityCounts = asRecord(asRecord(parsed.metadata).vulnerabilities);
  const rawCounts = {
    critical: numberValue(vulnerabilityCounts.critical),
    high: numberValue(vulnerabilityCounts.high),
    moderate: numberValue(vulnerabilityCounts.moderate),
    low: numberValue(vulnerabilityCounts.low),
  };

  const vulnerabilities = asRecord(parsed.vulnerabilities);
  const summarized = Object.entries(vulnerabilities).map(([name, value]) => summarizeVulnerability(name, value));
  const blockingFindingDetails = summarized.flatMap((entry) => entry.blocking ? [entry.blocking] : []);
  const reviewedFindingDetails = summarized.flatMap((entry) => entry.reviewed);
  const reviewedHighOrCriticalCount = summarized.filter((entry) => entry.blocking === null && entry.reviewed.length > 0).length;
  const counts = {
    critical: rawCounts.critical,
    high: Math.max(0, rawCounts.high - reviewedHighOrCriticalCount),
    moderate: rawCounts.moderate,
    low: rawCounts.low,
  };
  const countDetail =
    `npm audit summary: ${rawCounts.critical} critical, ${rawCounts.high} high, ` +
    `${rawCounts.moderate} moderate, ${rawCounts.low} low` +
    (reviewedHighOrCriticalCount > 0
      ? `; ${reviewedHighOrCriticalCount} high/critical finding(s) have exact reviewed mitigations, leaving ${counts.critical} critical and ${counts.high} high blocking.`
      : ".");

  return {
    counts,
    rawCounts,
    countDetail,
    blockingDetail: blockingFindingDetails.length > 0
      ? `Blocking npm audit advisories: ${blockingFindingDetails.join(" | ")}.`
      : null,
    blockingFindingDetails,
    reviewedFindingDetails,
  };
}
