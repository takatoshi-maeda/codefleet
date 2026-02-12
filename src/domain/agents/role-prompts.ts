import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodefleetError } from "../../shared/errors.js";
import type { AgentRole } from "../roles-model.js";

const promptCache = new Map<AgentRole, string>();
const eventPromptCache = new Map<string, string | null>();

export async function getRoleStartupPrompt(role: AgentRole): Promise<string> {
  const cached = promptCache.get(role);
  if (cached) {
    return cached;
  }

  const promptPath = path.join(resolveProjectRoot(), "src/prompts", roleToPromptDir(role), "instructions.md");
  try {
    const prompt = await fs.readFile(promptPath, "utf8");
    promptCache.set(role, prompt);
    return prompt;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new CodefleetError("ERR_NOT_FOUND", `role instructions not found: ${promptPath}`);
    }
    throw error;
  }
}

export async function getRoleEventPromptTemplate(role: AgentRole, eventType: string): Promise<string | null> {
  const cacheKey = `${role}:${eventType}`;
  if (eventPromptCache.has(cacheKey)) {
    return eventPromptCache.get(cacheKey) ?? null;
  }

  const promptPath = path.join(resolveProjectRoot(), "src/prompts", roleToPromptDir(role), "events", `${eventType}.md`);
  try {
    const prompt = await fs.readFile(promptPath, "utf8");
    eventPromptCache.set(cacheKey, prompt);
    return prompt;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      eventPromptCache.set(cacheKey, null);
      return null;
    }
    throw error;
  }
}

function roleToPromptDir(role: AgentRole): string {
  return role.toLowerCase();
}

function resolveProjectRoot(): string {
  // This module is emitted to `dist/domain/agents`; the same traversal from `src` and `dist`
  // reaches repository root, which keeps prompt path resolution stable in dev and build runs.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..", "..");
}
