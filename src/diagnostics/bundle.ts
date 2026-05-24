import { collectHiveWrightDiagnostics, getHiveWrightHealthSnapshot } from "./checks";

export type DiagnosticBundle = {
  generatedAt: string;
  health: ReturnType<typeof getHiveWrightHealthSnapshot>;
  readiness: {
    ready: boolean;
    severity: string;
    counts: Record<string, number>;
    ownerActionRequired: boolean;
  };
  diagnostics: Awaited<ReturnType<typeof collectHiveWrightDiagnostics>>["diagnostics"];
  recentFailureGroups: Awaited<ReturnType<typeof collectHiveWrightDiagnostics>>["recentFailureGroups"];
};

export async function buildDiagnosticBundle(): Promise<DiagnosticBundle> {
  const generatedAt = new Date().toISOString();
  const diagnostics = await collectHiveWrightDiagnostics();
  return {
    generatedAt,
    health: getHiveWrightHealthSnapshot({ now: new Date(generatedAt) }),
    readiness: {
      ready: diagnostics.summary.ready,
      severity: diagnostics.summary.severity,
      counts: diagnostics.summary.counts,
      ownerActionRequired: diagnostics.summary.ownerActionRequired,
    },
    diagnostics: diagnostics.diagnostics,
    recentFailureGroups: diagnostics.recentFailureGroups,
  };
}
