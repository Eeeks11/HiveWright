import type { ChatProvider, ChatRequest } from "./types";

export type StructuredJsonPrimitiveType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface StructuredJsonSchema {
  type: StructuredJsonPrimitiveType;
  required?: string[];
  properties?: Record<string, StructuredJsonSchema>;
  items?: StructuredJsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface GenerateStructuredJsonInput {
  provider: ChatProvider;
  request: ChatRequest;
  schema: StructuredJsonSchema;
  maxAttempts?: number;
  validate?: (value: unknown) => string[] | void;
}

export interface GenerateStructuredJsonResult<T> {
  value: T;
  attempts: number;
}

export async function generateStructuredJson<T = unknown>(
  input: GenerateStructuredJsonInput,
): Promise<GenerateStructuredJsonResult<T>> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);
  let lastError = "structured output was not attempted";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const request = attempt === 1
      ? input.request
      : retryRequest(input.request, lastError);
    const response = await input.provider.chat(request);

    try {
      const value = parseStructuredJson<T>(response.text, input.schema);
      const semanticErrors = input.validate?.(value) ?? [];
      if (semanticErrors.length > 0) throw new Error(semanticErrors.join("; "));
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "structured output validation failed";
    }
  }

  throw new Error(`structured output failed after ${maxAttempts} attempts: ${lastError}`);
}

export function parseStructuredJson<T = unknown>(text: string, schema: StructuredJsonSchema): T {
  const jsonText = extractJsonValue(text);
  if (!jsonText) throw new Error("AI response did not include JSON");

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(`AI response JSON could not be parsed: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }

  const errors = validateStructuredJson(parsed, schema);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return parsed as T;
}

export function validateStructuredJson(
  value: unknown,
  schema: StructuredJsonSchema,
  path = "$",
): string[] {
  const errors: string[] = [];

  if (schema.enum && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push(`${displayPath(path)} must be one of ${schema.enum.map(String).join(", ")}`);
    return errors;
  }

  if (!matchesType(value, schema.type)) {
    errors.push(`${displayPath(path)} must be ${article(schema.type)} ${schema.type}`);
    return errors;
  }

  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${displayPath(joinPath(path, key))} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) errors.push(...validateStructuredJson(record[key], childSchema, joinPath(path, key)));
    }
  }

  if (schema.type === "array") {
    const array = value as unknown[];
    if (schema.minItems !== undefined && array.length < schema.minItems) {
      errors.push(`${displayPath(path)} must include at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
    }
    if (schema.maxItems !== undefined && array.length > schema.maxItems) {
      errors.push(`${displayPath(path)} must include at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}`);
    }
    if (schema.items) {
      array.forEach((item, index) => {
        errors.push(...validateStructuredJson(item, schema.items as StructuredJsonSchema, `${path}[${index}]`));
      });
    }
  }

  if (schema.type === "string") {
    const stringValue = value as string;
    if (schema.minLength !== undefined && stringValue.length < schema.minLength) {
      errors.push(`${displayPath(path)} must be at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}`);
    }
    if (schema.maxLength !== undefined && stringValue.length > schema.maxLength) {
      errors.push(`${displayPath(path)} must be at most ${schema.maxLength} character${schema.maxLength === 1 ? "" : "s"}`);
    }
  }

  if (schema.type === "number" || schema.type === "integer") {
    const numberValue = value as number;
    if (schema.minimum !== undefined && numberValue < schema.minimum) {
      errors.push(`${displayPath(path)} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && numberValue > schema.maximum) {
      errors.push(`${displayPath(path)} must be <= ${schema.maximum}`);
    }
  }

  return errors;
}

function retryRequest(request: ChatRequest, validationError: string): ChatRequest {
  return {
    ...request,
    temperature: request.temperature ?? 0,
    user: [
      request.user,
      "",
      "Previous structured-output attempt failed validation.",
      `Validation error: ${validationError}`,
      "Return JSON only and conform exactly to the requested schema. Do not add prose, markdown, or comments.",
    ].join("\n"),
  };
}

function extractJsonValue(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return extractJsonValue(fenced[1]);

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "{" && char !== "[") continue;
    const extracted = scanJsonValue(text, index);
    if (extracted) return extracted;
  }
  return null;
}

function scanJsonValue(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function matchesType(value: unknown, type: StructuredJsonPrimitiveType): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  return typeof value === type;
}

function joinPath(path: string, key: string): string {
  return path === "$" ? key : `${path}.${key}`;
}

function displayPath(path: string): string {
  return path === "$" ? "response" : path;
}

function article(type: string): string {
  return /^[aeiou]/i.test(type) ? "an" : "a";
}
