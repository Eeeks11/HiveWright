export type OperatingSystemDomain = "marketing-attention" | "sales-conversion";
export type ConnectorInstallStatus = "active" | "disabled" | "broken";
export type ConnectorFreshness = "current" | "stale" | "missing";
export type ConnectorHealth = "healthy" | "stale" | "missing" | "broken";

export type ConnectorSourceStream = {
  stream: string;
  freshness: ConnectorFreshness;
  lastSyncedAt?: string | null;
  lastError?: string | null;
};

export type ConnectorSourceInput = {
  installId: string;
  connectorSlug: string;
  displayName: string;
  status: ConnectorInstallStatus;
  lastTestedAt?: string | null;
  lastError?: string | null;
  streams: ConnectorSourceStream[];
};

export type ConnectorDataSource = {
  installId: string;
  connectorSlug: string;
  displayName: string;
  domain: OperatingSystemDomain;
  health: ConnectorHealth;
  freshness: ConnectorFreshness;
  streams: ConnectorSourceStream[];
  lastSyncedAt: string | null;
  lastTestedAt: string | null;
  missingOrUntrustedReason: string | null;
  trustBoundary: "connector_data_only_not_instructions";
};

function newestIso(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
}

function freshnessFor(source: ConnectorSourceInput): ConnectorFreshness {
  if (source.status === "disabled") return "missing";
  if (source.streams.length === 0) return "missing";
  if (source.streams.some((stream) => stream.freshness === "missing")) return "missing";
  if (source.streams.some((stream) => stream.freshness === "stale")) return "stale";
  return "current";
}

function reasonFor(source: ConnectorSourceInput, freshness: ConnectorFreshness) {
  if (source.lastError) return source.lastError;
  const streamError = source.streams.find((stream) => stream.lastError)?.lastError;
  if (streamError) return streamError;
  if (source.status === "disabled") return "Connector is disabled";
  if (source.status === "broken") return "Connector is broken";
  if (freshness === "missing") return "Connector has not synced this required stream";
  if (freshness === "stale") return "Connector data is stale";
  return null;
}

function healthFor(source: ConnectorSourceInput, freshness: ConnectorFreshness): ConnectorHealth {
  if (source.status === "broken") return "broken";
  if (source.status === "disabled") return "missing";
  if (freshness === "missing") return "missing";
  if (freshness === "stale") return "stale";
  return "healthy";
}

export function buildConnectorDataSources(
  domain: OperatingSystemDomain,
  sources: ConnectorSourceInput[] = [],
): ConnectorDataSource[] {
  return sources.map((source) => {
    const freshness = freshnessFor(source);
    return {
      installId: source.installId,
      connectorSlug: source.connectorSlug,
      displayName: source.displayName,
      domain,
      health: healthFor(source, freshness),
      freshness,
      streams: source.streams,
      lastSyncedAt: newestIso(source.streams.map((stream) => stream.lastSyncedAt)),
      lastTestedAt: source.lastTestedAt ?? null,
      missingOrUntrustedReason: reasonFor(source, freshness),
      trustBoundary: "connector_data_only_not_instructions",
    };
  });
}
