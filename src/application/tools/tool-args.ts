export function normalizeToolArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  if ("arguments" in value) {
    const wrapped = (value as { arguments?: unknown }).arguments;
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      return wrapped as Record<string, unknown>;
    }
  }
  return value as Record<string, unknown>;
}
