import { describe, expect, it } from "vitest";
import type { ChatProvider, ChatRequest, ChatResponse } from "./types";
import { generateStructuredJson, type StructuredJsonSchema } from "./structured";

class ScriptedProvider implements ChatProvider {
  readonly id = "openrouter" as const;
  readonly requests: ChatRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const text = this.responses.shift();
    if (text === undefined) throw new Error("no scripted response left");
    return {
      text,
      tokensIn: 10,
      tokensOut: 5,
      model: request.model,
      provider: this.id,
    };
  }
}

const proposalSchema: StructuredJsonSchema = {
  type: "object",
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "confidence"],
        properties: {
          title: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

describe("generateStructuredJson", () => {
  it("retries with validation feedback until the model returns schema-valid JSON", async () => {
    const provider = new ScriptedProvider([
      "```json\n{\"proposals\":[{\"title\":\"Fee schedule\",\"confidence\":1.8}]}\n```",
      "{\"proposals\":[{\"title\":\"Fee schedule\",\"confidence\":0.8}]}",
    ]);

    const result = await generateStructuredJson<{ proposals: Array<{ title: string; confidence: number }> }>({
      provider,
      request: {
        system: "Extract proposals.",
        user: "Document text",
        model: "test-model",
      },
      schema: proposalSchema,
      maxAttempts: 2,
    });

    expect(result.value.proposals[0]).toEqual({ title: "Fee schedule", confidence: 0.8 });
    expect(result.attempts).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].user).toContain("Previous structured-output attempt failed validation");
    expect(provider.requests[1].user).toContain("proposals[0].confidence must be <= 1");
  });

  it("fails closed when all attempts return malformed or schema-invalid output", async () => {
    const provider = new ScriptedProvider(["not json", "{\"proposals\":[]}"]);

    await expect(generateStructuredJson({
      provider,
      request: {
        system: "Extract proposals.",
        user: "Document text",
        model: "test-model",
      },
      schema: {
        type: "object",
        required: ["proposals"],
        properties: {
          proposals: { type: "array", minItems: 1 },
        },
      },
      maxAttempts: 2,
    })).rejects.toThrow("structured output failed after 2 attempts");
  });
});
