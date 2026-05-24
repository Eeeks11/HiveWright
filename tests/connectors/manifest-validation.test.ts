import { describe, expect, it } from "vitest";
import { validateConnectorManifest } from "@/connectors/manifest-validation";
import { normalizeConnector } from "@/connectors/registry";
import type { ConnectorDefinition, ConnectorOperation } from "@/connectors/registry";

function readOperation(overrides: Partial<ConnectorOperation> = {}): ConnectorOperation {
  return {
    slug: "read",
    label: "Read",
    inputSchema: { type: "object", properties: {} },
    outputSummary: "Reads sample data.",
    governance: {
      effectType: "read",
      defaultDecision: "allow",
      riskTier: "low",
      scopes: ["sample-connector:read"],
      externalSideEffect: false,
    },
    handler: async () => ({}),
    ...overrides,
  };
}

function manifest(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    slug: "sample-connector",
    name: "Sample",
    category: "ops",
    description: "Sample connector",
    authType: "api_key",
    setupFields: [{ key: "token", label: "Token", type: "password", required: true }],
    secretFields: ["token"],
    scopes: [{ key: "sample-connector:read", label: "Read", kind: "read", required: true }],
    operations: [readOperation()],
    capabilities: ["health"],
    ...overrides,
  };
}

describe("connector manifest validation", () => {
  it("accepts a complete governed manifest", () => {
    expect(validateConnectorManifest(manifest()).valid).toBe(true);
  });

  it("rejects missing and malformed connector metadata", () => {
    const result = validateConnectorManifest(manifest({ slug: "Bad Slug", category: "bad" as never }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("kebab-case");
    expect(result.errors.join("\n")).toContain("category");
  });

  it("requires secret fields and oauth config to be declared", () => {
    expect(validateConnectorManifest(manifest({ secretFields: ["missing"] })).errors.join("\n")).toContain("secret field missing");
    expect(validateConnectorManifest(manifest({ authType: "oauth2", oauth: undefined })).errors.join("\n")).toContain("oauth2 connectors");
  });

  it("rejects side-effect and financial/destructive operations that default to allow", () => {
    const result = validateConnectorManifest(manifest({
      operations: [{
        slug: "charge",
        label: "Charge",
        inputSchema: { type: "object", properties: { amount: { type: "number" } } },
        outputSummary: "Creates a charge.",
        governance: { effectType: "financial", defaultDecision: "allow", riskTier: "high", externalSideEffect: true },
        handler: async () => ({}),
      }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("cannot default to allow");
  });

  it("rejects operations missing platform metadata", () => {
    const result = validateConnectorManifest(manifest({
      operations: [
        readOperation({ inputSchema: undefined as never }),
        readOperation({ slug: "missing-output", outputSummary: "" }),
        readOperation({ slug: "missing-governance", governance: undefined as never }),
      ],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("sample-connector.read must declare object input schema");
    expect(result.errors.join("\n")).toContain("sample-connector.missing-output must declare output summary");
    expect(result.errors.join("\n")).toContain("sample-connector.missing-governance must declare governance");
  });

  it("rejects unsupported governance enum values", () => {
    const result = validateConnectorManifest(manifest({
      operations: [readOperation({
        governance: {
          effectType: "unknown" as never,
          defaultDecision: "maybe" as never,
          riskTier: "severe" as never,
          externalSideEffect: false,
        },
      })],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("valid governance effect type");
    expect(result.errors.join("\n")).toContain("valid governance default decision");
    expect(result.errors.join("\n")).toContain("valid governance risk tier");
  });

  it("rejects side-effecting operations without an explicit external side-effect flag", () => {
    const result = validateConnectorManifest(manifest({
      operations: [readOperation({
        slug: "send",
        label: "Send",
        governance: {
          effectType: "notify",
          defaultDecision: "require_approval",
          riskTier: "low",
          scopes: ["sample-connector:read"],
          externalSideEffect: false,
        },
      })],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("must declare externalSideEffect true");
  });

  it("rejects health and test operations that are not safe system operations", () => {
    const result = validateConnectorManifest(manifest({
      operations: [readOperation({
        slug: "test_connection",
        label: "Test connection",
        governance: {
          effectType: "read",
          defaultDecision: "allow",
          riskTier: "low",
          scopes: ["sample-connector:read"],
          externalSideEffect: false,
        },
      })],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("health/test operation must use system effect");
  });

  it("accepts generated test_connection as safe health metadata", () => {
    const connector = normalizeConnector({
      slug: "generated-health",
      name: "Generated health",
      category: "ops",
      description: "Connector with generated test connection.",
      authType: "none",
      setupFields: [],
      secretFields: [],
      operations: [readOperation({
        governance: {
          effectType: "read",
          defaultDecision: "allow",
          riskTier: "low",
          externalSideEffect: false,
        },
      })],
    });

    const testConnection = connector.operations.find((operation) => operation.slug === "test_connection");

    expect(testConnection?.governance).toMatchObject({
      effectType: "system",
      defaultDecision: "allow",
      riskTier: "low",
      externalSideEffect: false,
    });
    expect(validateConnectorManifest(connector).valid).toBe(true);
  });

  it("rejects unsupported connector capabilities", () => {
    const result = validateConnectorManifest(manifest({
      capabilities: ["health", "unsafe_marketplace" as never],
    }));

    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("unsupported capability unsafe_marketplace");
  });
});
