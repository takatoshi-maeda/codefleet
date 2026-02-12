import { CodefleetError } from "../../shared/errors.js";

export interface EventPromptTemplateContext {
  [key: string]: unknown;
}

const TEMPLATE_TOKEN = /{{\s*([a-zA-Z0-9_.]+)\s*}}/g;

export function renderEventPromptTemplate(template: string, context: EventPromptTemplateContext): string {
  return template.replaceAll(TEMPLATE_TOKEN, (_token, keyPath: string) => {
    const resolved = resolveKeyPath(context, keyPath);
    if (resolved === undefined) {
      throw new CodefleetError("ERR_VALIDATION", `event prompt template variable is not defined: ${keyPath}`);
    }
    return stringifyTemplateValue(resolved);
  });
}

function resolveKeyPath(source: unknown, keyPath: string): unknown {
  const segments = keyPath.split(".");
  let current: unknown = source;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string")
      ? value.join(", ")
      : JSON.stringify(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
