import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";

const GITIGNORE_PATH = ".gitignore";
const DATA_DIR_IGNORE_ENTRY = "/.codefleet/data/";

export function createInitCommand(): Command {
  const cmd = new Command("init");
  cmd.description("Initialize local codefleet settings.");

  cmd.action(async () => {
    const result = await ensureDataDirIgnored();
    if (result.updated) {
      console.log(`updated ${GITIGNORE_PATH}: added ${DATA_DIR_IGNORE_ENTRY}`);
      return;
    }

    console.log(`${GITIGNORE_PATH} already contains ${DATA_DIR_IGNORE_ENTRY}`);
  });

  return cmd;
}

interface EnsureDataDirIgnoredResult {
  updated: boolean;
}

async function ensureDataDirIgnored(): Promise<EnsureDataDirIgnoredResult> {
  const gitignorePath = path.join(process.cwd(), GITIGNORE_PATH);

  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }

  const entries = current
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (hasEquivalentEntry(entries, DATA_DIR_IGNORE_ENTRY)) {
    return { updated: false };
  }

  // Keep ignore entry root-anchored so nested folders with the same name are not over-ignored.
  const prefix = current.length === 0 ? "" : current.replace(/\s*$/u, "\n");
  const next = `${prefix}${DATA_DIR_IGNORE_ENTRY}\n`;
  await fs.writeFile(gitignorePath, next, "utf8");
  return { updated: true };
}

function hasEquivalentEntry(entries: string[], entry: string): boolean {
  const normalizedEntry = normalizeIgnoreEntry(entry);
  return entries.some((line) => normalizeIgnoreEntry(line) === normalizedEntry);
}

function normalizeIgnoreEntry(entry: string): string {
  return entry.replace(/^\.?\//u, "").replace(/\/+$/u, "");
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
