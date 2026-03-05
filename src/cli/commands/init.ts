import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";

const GITIGNORE_PATH = ".gitignore";
const CONFIG_PATH = ".codefleet/config.json";
const DOCS_SUBMODULE_PATH = "docs/spec";
const IGNORE_ENTRIES = ["/.codefleet/data/", "/.codefleet/runtime/", "/.codefleet/logs/", "/.codefleet/archives/"] as const;
const AGENT_ROLES = ["Orchestrator", "Developer", "Polisher", "Gatekeeper", "Reviewer"] as const;
const HOOK_PHASES = ["before_start", "after_complete", "after_fail"] as const;

interface InitCommandDeps {
  askRequiredQuestion?: (message: string, envKey: string) => Promise<string>;
  addDocsSubmodule?: (repository: string, targetPath: string) => Promise<void>;
}

export function createInitCommand(deps: InitCommandDeps = {}): Command {
  const cmd = new Command("init");
  cmd.description("Initialize local codefleet settings.");

  cmd.action(async () => {
    const askQuestion = deps.askRequiredQuestion ?? askRequiredQuestion;
    const addSubmodule = deps.addDocsSubmodule ?? addDocsSubmodule;
    const gitignoreResult = await ensureCodefleetDirsIgnored();
    logGitignoreResult(gitignoreResult);

    const docsRepository = await askQuestion(
      "Document repository URL (submodule for docs/spec): ",
      "CODEFLEET_INIT_DOCS_REPOSITORY",
    );
    const lang = await askQuestion("Language for codefleet responses (lang): ", "CODEFLEET_INIT_LANG");

    await addSubmodule(docsRepository, DOCS_SUBMODULE_PATH);
    await writeConfig({
      lang,
      docsRepository,
      hooks: createHooksSkeleton(),
    });
    console.log(`created ${CONFIG_PATH}`);
  });

  return cmd;
}

interface EnsureDataDirIgnoredResult {
  addedEntries: string[];
}

interface CodefleetConfig {
  lang: string;
  docsRepository: string;
  hooks: HooksConfig;
}

type HooksConfig = Record<
  (typeof AGENT_ROLES)[number],
  Record<(typeof HOOK_PHASES)[number], string[]>
>;

async function ensureCodefleetDirsIgnored(): Promise<EnsureDataDirIgnoredResult> {
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
  const missingEntries = IGNORE_ENTRIES.filter((entry) => !hasEquivalentEntry(entries, entry));
  if (missingEntries.length === 0) {
    return { addedEntries: [] };
  }

  // Keep ignore entries root-anchored so nested folders with the same names are not over-ignored.
  const prefix = current.length === 0 ? "" : current.replace(/\s*$/u, "\n");
  const next = `${prefix}${missingEntries.join("\n")}\n`;
  await fs.writeFile(gitignorePath, next, "utf8");
  return { addedEntries: [...missingEntries] };
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

function logGitignoreResult(result: EnsureDataDirIgnoredResult): void {
  if (result.addedEntries.length === 0) {
    console.log(`${GITIGNORE_PATH} already contains required codefleet entries`);
    return;
  }
  console.log(`updated ${GITIGNORE_PATH}: added ${result.addedEntries.join(", ")}`);
}

async function askRequiredQuestion(message: string, envKey: string): Promise<string> {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`interactive prompt requires a TTY (or set ${envKey})`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    const normalized = answer.trim();
    if (normalized.length === 0) {
      throw new Error("input cannot be empty");
    }
    return normalized;
  } finally {
    rl.close();
  }
}

async function addDocsSubmodule(repository: string, targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["submodule", "add", repository, targetPath], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git submodule add failed (exit ${code ?? "unknown"})`));
    });
  });
}

async function writeConfig(config: CodefleetConfig): Promise<void> {
  const configPath = path.join(process.cwd(), CONFIG_PATH);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function createHooksSkeleton(): HooksConfig {
  const hooks = {} as HooksConfig;
  for (const role of AGENT_ROLES) {
    hooks[role] = {
      // Empty arrays keep the expected shape explicit while remaining valid hook values.
      before_start: [],
      after_complete: [],
      after_fail: [],
    };
  }
  return hooks;
}
