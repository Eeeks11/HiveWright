export type DiagnosticSeverity = "ok" | "info" | "warning" | "critical";

export type DiagnosticStatus = {
  id: string;
  label: string;
  severity: DiagnosticSeverity;
  summary: string;
  details?: string;
  affectedHiveIds?: string[];
  affectedGoalIds?: string[];
  affectedTaskIds?: string[];
  recommendedAction?: string;
  safeAutomaticAction?: string;
  requiresOwnerAction?: boolean;
  checkedAt: string;
};

export type DiagnosticSummary = {
  severity: DiagnosticSeverity;
  ready: boolean;
  counts: Record<DiagnosticSeverity, number>;
  ownerActionRequired: boolean;
};

export type HiveWrightDiagnosticsScope = {
  kind: "controller_global";
  label: string;
  summary: string;
  hiveScopedReadinessEndpoint: string;
};

export type BuildDiagnosticStatusInput = Omit<DiagnosticStatus, "checkedAt"> & {
  checkedAt: Date | string;
};

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  ok: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

const SECRET_PATTERNS: RegExp[] = [
  /\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*([^\s,;]+)/gi,
  /\bDATABASE_URL\s*=\s*([^\s,;]+)/gi,
  /\bAuthorization:\s*Bearer\s+([^\s,;]+)/gi,
  /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
];

export function buildDiagnosticStatus(input: BuildDiagnosticStatusInput): DiagnosticStatus {
  const status: DiagnosticStatus = {
    ...input,
    summary: redactDiagnosticText(input.summary),
    checkedAt: input.checkedAt instanceof Date ? input.checkedAt.toISOString() : input.checkedAt,
  };

  if (input.details) status.details = redactDiagnosticText(input.details);
  if (input.recommendedAction) status.recommendedAction = redactDiagnosticText(input.recommendedAction);
  if (input.safeAutomaticAction) status.safeAutomaticAction = redactDiagnosticText(input.safeAutomaticAction);

  return status;
}

export function redactDiagnosticText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, captured) => {
      if (!captured) return "[redacted]";
      return match.replace(captured, "[redacted]");
    });
  }
  return redacted;
}

export function summarizeDiagnostics(statuses: DiagnosticStatus[]): DiagnosticSummary {
  const counts: Record<DiagnosticSeverity, number> = {
    ok: 0,
    info: 0,
    warning: 0,
    critical: 0,
  };
  let severity: DiagnosticSeverity = "ok";
  let ownerActionRequired = false;

  for (const status of statuses) {
    counts[status.severity] += 1;
    if (SEVERITY_RANK[status.severity] > SEVERITY_RANK[severity]) {
      severity = status.severity;
    }
    ownerActionRequired ||= status.requiresOwnerAction === true;
  }

  return {
    severity,
    ready: counts.critical === 0,
    counts,
    ownerActionRequired,
  };
}

export function severityRank(severity: DiagnosticSeverity): number {
  return SEVERITY_RANK[severity];
}
