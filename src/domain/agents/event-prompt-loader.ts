import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodefleetError } from "../../shared/errors.js";

const promptCache = new Map<string, string>();

export async function loadEventPrompt(promptFile: string): Promise<string> {
  const cached = promptCache.get(promptFile);
  if (cached) {
    return cached;
  }

  const promptPath = path.join(resolveProjectRoot(), "src/prompts", promptFile);
  try {
    const prompt = await fs.readFile(promptPath, "utf8");
    promptCache.set(promptFile, prompt);
    return prompt;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new CodefleetError("ERR_NOT_FOUND", `event prompt not found: ${promptPath}`);
    }
    throw error;
  }
}

function resolveProjectRoot(): string {
  // Keep the same root traversal strategy used by startup prompt loading so
  // event prompt paths resolve identically from src and dist builds.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..", "..");
}
