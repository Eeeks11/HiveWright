/**
 * Connector plugin SDK: public connector contracts, manifest normalization,
 * dashboard-safe serialization, and runtime plugin registration helpers.
 */

export type ConnectorAuthType = "api_key" | "oauth2" | "webhook" | "none";
export type ConnectorEffectType = "read" | "notify" | "write" | "financial" | "destructive" | "system";
export type ConnectorApprovalDefault = "allow" | "require_approval" | "block";
export type ConnectorRiskTier = "low" | "medium" | "high" | "critical";
export type ConnectorScopeKind = "read" | "write" | "send" | "admin" | "financial" | "pii";

export interface ConnectorScopeDeclaration {
  key: string;
  label: string;
  kind: ConnectorScopeKind;
  required: boolean;
  description?: string;
}

export interface ConnectorOperationInputSchema {
  type: "object";
  required?: string[];
  properties: Record<string, {
    type: "string" | "number" | "boolean" | "object" | "array";
    description?: string;
    enum?: string[];
    format?: string;
  }>;
}

export interface ConnectorOperationGovernance {
  effectType: ConnectorEffectType;
  defaultDecision: ConnectorApprovalDefault;
  riskTier: ConnectorRiskTier;
  scopes?: string[];
  summary?: string;
  dryRunSupported?: boolean;
  externalSideEffect?: boolean;
}

/**
 * OAuth2 tokens persisted per-install in the credentials table. Stored as
 * JSON in the encrypted `value` field. `expiresAt` is ISO 8601.
 */
export interface OAuth2TokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

export interface ConnectorSetupField {
  key: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  type?: "text" | "url" | "password" | "textarea";
  required?: boolean;
}

export interface ConnectorOperation {
  slug: string;
  label: string;
  /** JSON-schema-ish argument spec for dashboard "Test" forms. */
  args?: ConnectorSetupField[];
  inputSchema: ConnectorOperationInputSchema;
  outputSummary: string;
  governance: ConnectorOperationGovernance;
  handler: (ctx: ConnectorInvocationContext) => Promise<unknown>;
}

/**
 * OAuth2 provider config. Present only on connectors where authType is
 * "oauth2". The client id/secret live in env (not the registry file) so
 * we can open-source the catalog without leaking credentials.
 */
export interface OAuth2Config {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra params appended to the authorize URL (e.g. access_type=offline for Google). */
  extraAuthorizeParams?: Record<string, string>;
}

export interface ConnectorDefinition {
  pluginSlug?: string;
  slug: string;
  name: string;
  category: "messaging" | "email" | "calendar" | "finance" | "crm" | "ads" | "payments" | "ops" | "ea" | "other";
  description: string;
  icon?: string; // emoji for now; real SVGs later
  authType: ConnectorAuthType;
  setupFields: ConnectorSetupField[];
  secretFields: string[];
  scopes: ConnectorScopeDeclaration[];
  operations: ConnectorOperation[];
  oauth?: OAuth2Config;
  testConnection?: (ctx: ConnectorInvocationContext) => Promise<unknown>;
  /**
   * Connectors that open a persistent listener inside the dispatcher
   * (e.g. the Discord-hosted EA) need a dispatcher restart before a
   * new install takes effect. Dashboard surfaces an "Activate" button
   * after successful install-and-test when this is true.
   */
  requiresDispatcherRestart?: boolean;
}

export type ConnectorDefinitionDraft = Omit<ConnectorDefinition, "pluginSlug" | "scopes" | "operations"> & {
  scopes?: ConnectorScopeDeclaration[];
  operations: ConnectorOperation[];
};

/**
 * Passed to every operation handler. `config` is the non-secret install
 * config, `secrets` holds decrypted credential values keyed the same way
 * as secretFields, `args` is the operation-specific payload.
 */
export interface ConnectorInvocationContext {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  args: Record<string, unknown>;
}


export interface ConnectorPlugin {
  slug: string;
  name?: string;
  description?: string;
  connectors: ConnectorDefinitionDraft[];
}

export interface ConnectorPluginMetadata {
  slug: string;
  name: string;
  description?: string;
  connectorSlugs: string[];
}

export function defineConnectorPlugin(plugin: ConnectorPlugin): ConnectorPlugin {
  return plugin;
}

function defaultScopeKind(effectType: ConnectorEffectType): ConnectorScopeKind {
  if (effectType === "read" || effectType === "system") return "read";
  if (effectType === "notify") return "send";
  if (effectType === "financial") return "financial";
  if (effectType === "destructive") return "admin";
  return "write";
}

export function normalizeConnector(connector: ConnectorDefinitionDraft, pluginSlug = "unknown"): ConnectorDefinition {
  const generatedTestOperation: ConnectorOperation = {
    slug: "test_connection",
    label: "Test connection",
    args: [],
    inputSchema: { type: "object", properties: {} },
    outputSummary: "Returns connector installation health without performing external side effects.",
    governance: {
      effectType: "system",
      defaultDecision: "allow",
      riskTier: "low",
      summary: "Checks that the connector install is present and can be invoked by the health/test route.",
      dryRunSupported: false,
      externalSideEffect: false,
    },
    handler: connector.testConnection ?? (async () => ({ ok: true })),
  };
  const baseOperations: ConnectorOperation[] = connector.operations.some((op) => ["test_connection", "self_test"].includes(op.slug))
    ? connector.operations
    : [generatedTestOperation, ...connector.operations];
  const operationScopes = baseOperations.map((op) => ({
    key: `${connector.slug}:${op.slug}`,
    label: op.label,
    kind: defaultScopeKind(op.governance.effectType),
    required: op.governance.effectType === "read" || op.governance.effectType === "system",
    description: op.governance.summary,
  } satisfies ConnectorScopeDeclaration));
  const scopes = connector.scopes && connector.scopes.length > 0 ? connector.scopes : operationScopes;
  return {
    ...connector,
    pluginSlug,
    scopes,
    operations: baseOperations.map((op) => {
      const scopeKey = `${connector.slug}:${op.slug}`;
      return {
        ...op,
        governance: {
          ...op.governance,
          scopes: op.governance.scopes ?? [scopeKey],
        },
      };
    }),
  };
}

export interface ConnectorPluginRegistry {
  register(plugin: ConnectorPlugin): void;
  listPlugins(): ConnectorPluginMetadata[];
  list(): ConnectorDefinition[];
  get(slug: string): ConnectorDefinition | undefined;
}

class InMemoryConnectorPluginRegistry implements ConnectorPluginRegistry {
  private readonly connectors = new Map<string, ConnectorDefinition>();
  private readonly plugins = new Map<string, ConnectorPluginMetadata>();

  register(plugin: ConnectorPlugin): void {
    if (this.plugins.has(plugin.slug)) {
      throw new Error(`Connector plugin already registered: ${plugin.slug}`);
    }
    const pluginSlugs = new Set<string>();
    for (const draft of plugin.connectors) {
      if (pluginSlugs.has(draft.slug) || this.connectors.has(draft.slug)) {
        throw new Error(`Connector slug already registered: ${draft.slug}`);
      }
      pluginSlugs.add(draft.slug);
    }
    this.plugins.set(plugin.slug, {
      slug: plugin.slug,
      name: plugin.name ?? plugin.slug,
      description: plugin.description,
      connectorSlugs: plugin.connectors.map((connector) => connector.slug),
    });
    for (const draft of plugin.connectors) {
      this.connectors.set(draft.slug, normalizeConnector(draft, plugin.slug));
    }
  }

  listPlugins(): ConnectorPluginMetadata[] {
    return Array.from(this.plugins.values());
  }

  list(): ConnectorDefinition[] {
    return Array.from(this.connectors.values());
  }

  get(slug: string): ConnectorDefinition | undefined {
    return this.connectors.get(slug);
  }
}

export function createConnectorPluginRegistry(plugins: ConnectorPlugin[] = []): ConnectorPluginRegistry {
  const registry = new InMemoryConnectorPluginRegistry();
  for (const plugin of plugins) {
    registry.register(plugin);
  }
  return registry;
}

/**
 * Dashboard-safe view of a connector: metadata only, never the handlers.
 * Drops `handler` functions from each operation so it can be sent over
 * JSON without blowing up.
 */
export function toPublicConnector(c: ConnectorDefinition) {
  const secretFields = new Set(c.secretFields);
  return {
    slug: c.slug,
    pluginSlug: c.pluginSlug ?? "unknown",
    name: c.name,
    category: c.category,
    description: c.description,
    icon: c.icon ?? null,
    authType: c.authType,
    setupFields: c.setupFields.map((field) => ({
      ...field,
      type: secretFields.has(field.key) ? "password" as const : field.type,
      placeholder: secretFields.has(field.key) ? "[REDACTED]" : field.placeholder,
    })),
    scopes: c.scopes ?? [],
    operations: c.operations.map((op) => ({
      slug: op.slug,
      label: op.label,
      governance: op.governance,
      args: op.args ?? [],
      inputSchema: op.inputSchema,
      outputSummary: op.outputSummary,
    })),
    requiresDispatcherRestart: c.requiresDispatcherRestart ?? false,
  };
}
