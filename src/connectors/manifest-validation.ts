import type {
  ConnectorApprovalDefault,
  ConnectorCapability,
  ConnectorDefinition,
  ConnectorEffectType,
  ConnectorRiskTier,
} from "./registry";

const VALID_CATEGORIES = new Set([
  "messaging",
  "email",
  "calendar",
  "finance",
  "crm",
  "ads",
  "payments",
  "ops",
  "ea",
  "other",
]);

const VALID_EFFECT_TYPES: ConnectorEffectType[] = ["read", "notify", "write", "financial", "destructive", "system"];
const VALID_DEFAULTS: ConnectorApprovalDefault[] = ["allow", "require_approval", "block"];
const VALID_RISKS: ConnectorRiskTier[] = ["low", "medium", "high", "critical"];
const VALID_CAPABILITIES: ConnectorCapability[] = ["health", "sync", "webhook_ingest", "record_import", "action_execute"];

export interface ConnectorManifestValidationResult {
  valid: boolean;
  errors: string[];
}

function isSideEffectingEffect(effectType: ConnectorEffectType | undefined): boolean {
  return Boolean(effectType && effectType !== "read" && effectType !== "system");
}

export function validateConnectorManifest(connector: ConnectorDefinition): ConnectorManifestValidationResult {
  const errors: string[] = [];
  if (!connector.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(connector.slug)) {
    errors.push("connector slug must be present and kebab-case");
  }
  if (!VALID_CATEGORIES.has(connector.category)) {
    errors.push(`connector category ${connector.category} is not valid`);
  }
  for (const capability of connector.capabilities ?? []) {
    if (!VALID_CAPABILITIES.includes(capability)) {
      errors.push(`connector ${connector.slug} declares unsupported capability ${capability}`);
    }
  }
  const setupFieldKeys = new Set(connector.setupFields.map((field) => field.key));
  for (const secretField of connector.secretFields) {
    if (!setupFieldKeys.has(secretField)) {
      errors.push(`secret field ${secretField} is not declared in setupFields`);
    }
  }
  if (connector.authType === "oauth2" && !connector.oauth) {
    errors.push("oauth2 connectors must include oauth config");
  }

  const scopeKeys = new Set((connector.scopes ?? []).map((scope) => scope.key));
  for (const operation of connector.operations) {
    const prefix = `${connector.slug}.${operation.slug || "<missing>"}`;
    if (!operation.slug) errors.push(`${prefix} must declare slug`);
    if (!operation.label) errors.push(`${prefix} must declare label`);
    if (!operation.inputSchema || operation.inputSchema.type !== "object" || !operation.inputSchema.properties) {
      errors.push(`${prefix} must declare object input schema`);
    }
    if (!operation.outputSummary) errors.push(`${prefix} must declare output summary`);
    if (!operation.governance) {
      errors.push(`${prefix} must declare governance`);
      continue;
    }
    if (!VALID_EFFECT_TYPES.includes(operation.governance.effectType)) {
      errors.push(`${prefix} must declare valid governance effect type`);
    }
    if (!VALID_DEFAULTS.includes(operation.governance.defaultDecision)) {
      errors.push(`${prefix} must declare valid governance default decision`);
    }
    if (!operation.governance.riskTier || !VALID_RISKS.includes(operation.governance.riskTier)) {
      errors.push(`${prefix} must declare valid governance risk tier`);
    }
    for (const scope of operation.governance.scopes ?? []) {
      if (scopeKeys.size > 0 && !scopeKeys.has(scope)) {
        errors.push(`${prefix} references unknown scope ${scope}`);
      }
    }
    if (isSideEffectingEffect(operation.governance.effectType) && operation.governance.externalSideEffect !== true) {
      errors.push(`${prefix} side-effecting operation must declare externalSideEffect true`);
    }
    if (operation.governance.effectType !== "read" && operation.governance.effectType !== "system" && operation.governance.defaultDecision === "allow") {
      errors.push(`${prefix} has side effects and cannot default to allow`);
    }
    if (["financial", "destructive"].includes(operation.governance.effectType) && operation.governance.defaultDecision === "allow") {
      errors.push(`${prefix} is financial/destructive and cannot default to allow`);
    }
    if (["test_connection", "self_test"].includes(operation.slug)) {
      if (operation.governance.effectType !== "system") {
        errors.push(`${prefix} health/test operation must use system effect`);
      }
      if (operation.governance.defaultDecision !== "allow") {
        errors.push(`${prefix} health/test operation must default to allow`);
      }
      if (operation.governance.riskTier !== "low") {
        errors.push(`${prefix} health/test operation must be low risk`);
      }
      if (operation.governance.externalSideEffect !== false) {
        errors.push(`${prefix} health/test operation must declare externalSideEffect false`);
      }
    }
    if (operation.governance.effectType === "system") {
      const safeSystemTest = ["test_connection", "self_test"].includes(operation.slug) && operation.governance.defaultDecision === "allow";
      if (!safeSystemTest && operation.governance.defaultDecision === "allow") {
        errors.push(`${prefix} system allow operation must be an explicit test operation`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
