import { describe, expect, it } from "vitest";
import { evaluateGuardrails } from "@/guardrails/evaluator";
import {
  createActionPolicyGuardrailProvider,
  createConnectorScopeGuardrailProvider,
} from "@/guardrails/providers";
import type { ConnectorDefinition } from "@/connectors/registry";
import type { GuardrailProvider } from "@/guardrails/types";

const connector: ConnectorDefinition = {
  slug: "stripe",
  name: "Stripe",
  category: "payments",
  description: "test connector",
  authType: "api_key",
  setupFields: [],
  secretFields: [],
  scopes: [],
  operations: [
    {
      slug: "list_customers",
      label: "List customers",
      inputSchema: { type: "object", properties: {} },
      outputSummary: "lists customers",
      governance: {
        effectType: "read",
        defaultDecision: "allow",
        riskTier: "low",
        scopes: ["stripe:list_customers"],
      },
      handler: async () => ({}),
    },
    {
      slug: "refund_payment",
      label: "Refund payment",
      inputSchema: { type: "object", properties: {} },
      outputSummary: "refunds a payment",
      governance: {
        effectType: "financial",
        defaultDecision: "require_approval",
        riskTier: "high",
        scopes: ["stripe:refund_payment"],
      },
      handler: async () => ({}),
    },
  ],
};

function provider(name: string, effect: "allow" | "warn" | "approval_required" | "block", reason = name): GuardrailProvider {
  return { name, evaluate: () => ({ effect, reason }) };
}

describe("evaluateGuardrails", () => {
  it("applies precedence and accumulates reasons in provider order", async () => {
    const result = await evaluateGuardrails({ hiveId: "hive-1" }, [
      provider("allow-provider", "allow"),
      provider("warn-provider", "warn"),
      provider("approval-provider", "approval_required"),
      provider("block-provider", "block"),
    ]);

    expect(result.effect).toBe("block");
    expect(result.reasons.map((reason) => reason.provider)).toEqual([
      "allow-provider",
      "warn-provider",
      "approval-provider",
      "block-provider",
    ]);
  });

  it("fails closed when a critical provider throws", async () => {
    const result = await evaluateGuardrails({ hiveId: "hive-1" }, [{
      name: "critical",
      evaluate: () => { throw new Error("boom"); },
    }]);

    expect(result.effect).toBe("block");
    expect(result.reasons[0]?.message).toContain("failed closed");
  });

  it("turns non-critical provider exceptions into warnings", async () => {
    const result = await evaluateGuardrails({ hiveId: "hive-1" }, [{
      name: "optional",
      critical: false,
      evaluate: () => { throw new Error("offline"); },
    }]);

    expect(result.effect).toBe("warn");
    expect(result.reasons[0]?.message).toContain("failed open with warning");
  });

  it("audits aggregate decisions without raw args", async () => {
    const events: unknown[] = [];
    await evaluateGuardrails({
      hiveId: "hive-1",
      args: { secret: "do-not-log" },
      audit: { recordGuardrailDecision: (event) => { events.push(event); } },
    }, [provider("allow-provider", "allow")]);

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("do-not-log");
    expect(JSON.stringify(events[0])).toContain("argsPresent");
  });
});

describe("built-in guardrail providers", () => {
  it("maps action policy decisions to guardrail effects", async () => {
    const actionPolicy = createActionPolicyGuardrailProvider();

    await expect(Promise.resolve(actionPolicy.evaluate({
      hiveId: "hive-1",
      connectorSlug: "stripe",
      operation: "refund_payment",
      effectType: "financial",
      defaultDecision: "allow",
      actionPolicies: [],
    }))).resolves.toMatchObject({ effect: "allow" });

    await expect(Promise.resolve(actionPolicy.evaluate({
      hiveId: "hive-1",
      connectorSlug: "stripe",
      operation: "refund_payment",
      effectType: "financial",
      defaultDecision: "require_approval",
      actionPolicies: [],
    }))).resolves.toMatchObject({ effect: "approval_required" });

    await expect(Promise.resolve(actionPolicy.evaluate({
      hiveId: "hive-1",
      connectorSlug: "stripe",
      operation: "refund_payment",
      effectType: "financial",
      defaultDecision: "allow",
      actionPolicies: [{
        id: "policy-1",
        hiveId: "hive-1",
        connector: "stripe",
        operation: "refund_payment",
        effectType: "financial",
        effect: "block",
      }],
    }))).resolves.toMatchObject({ effect: "block", metadata: { policyId: "policy-1" } });
  });

  it("blocks connector operations when required scopes are missing", async () => {
    const scopeProvider = createConnectorScopeGuardrailProvider();
    const result = await scopeProvider.evaluate({
      hiveId: "hive-1",
      connectorSlug: "stripe",
      operation: "refund_payment",
      connectorDefinition: connector,
      grantedScopes: ["stripe:list_customers"],
    });

    expect(result).toMatchObject({ effect: "block" });
    expect(result.reason).toContain("missing scopes");
  });

  it("allows connector operations when all required scopes are present", async () => {
    const scopeProvider = createConnectorScopeGuardrailProvider();
    const result = await scopeProvider.evaluate({
      hiveId: "hive-1",
      connectorSlug: "stripe",
      operation: "refund_payment",
      connectorDefinition: connector,
      grantedScopes: ["stripe:refund_payment"],
    });

    expect(result).toMatchObject({ effect: "allow" });
  });

  it("does not grant authority for unknown connectors or operations", async () => {
    const scopeProvider = createConnectorScopeGuardrailProvider();

    const unknownConnector = await scopeProvider.evaluate({
      hiveId: "hive-1",
      connectorSlug: "unknown",
      operation: "refund_payment",
      connectorDefinition: connector,
      grantedScopes: ["stripe:refund_payment"],
    });

    const unknownOperation = await scopeProvider.evaluate({
      hiveId: "hive-1",
      connectorSlug: "stripe",
      operation: "unknown",
      connectorDefinition: connector,
      grantedScopes: ["stripe:refund_payment"],
    });

    expect(unknownConnector).toMatchObject({ effect: "block" });
    expect(unknownOperation).toMatchObject({ effect: "block" });
  });
});
