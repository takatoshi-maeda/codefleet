import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";

const DEFAULT_STATE_DIR = ".codefleet";
const ARCHIVES_DIRNAME = "archives";
const RESET_TARGET_DIRNAMES = ["data", "runtime", "logs"] as const;

interface StateCommandDeps {
  resolveGitCommitHash?: () => Promise<string>;
  createZipArchive?: (input: { outputPath: string; sourcePath: string; excludePatterns: string[] }) => Promise<void>;
  confirmReset?: () => Promise<boolean>;
}

export function createStateCommand(deps: StateCommandDeps = {}): Command {
  const resolveCommitHash = deps.resolveGitCommitHash ?? resolveGitCommitHash;
  const createArchive = deps.createZipArchive ?? createZipArchive;
  const confirmReset = deps.confirmReset ?? (() => confirmResetState({ input: process.stdin, output: process.stdout }));

  const cmd = new Command("state");
  cmd.description("Manage local .codefleet state");

  cmd
    .command("archive")
    .description("Archive current .codefleet state into .codefleet/archives/<git-commit-hash>.zip")
    .action(async () => {
      const stateDir = path.join(process.cwd(), DEFAULT_STATE_DIR);
      await assertDirectoryExists(stateDir);

      const commitHash = await resolveCommitHash();
      const archivesDir = path.join(stateDir, ARCHIVES_DIRNAME);
      await fs.mkdir(archivesDir, { recursive: true });

      const outputPath = path.join(archivesDir, `${commitHash}.zip`);
      // Excluding the archives subtree prevents recursive growth where each archive
      // would otherwise include prior archive files (and potentially itself).
      await createArchive({
        outputPath,
        sourcePath: DEFAULT_STATE_DIR,
        excludePatterns: [`.codefleet/${ARCHIVES_DIRNAME}`, `.codefleet/${ARCHIVES_DIRNAME}/*`],
      });

      console.log(`created ${path.relative(process.cwd(), outputPath)}`);
    });

  cmd
    .command("reset")
    .description("Reset .codefleet/data, .codefleet/runtime, and .codefleet/logs contents")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      const stateDir = path.join(process.cwd(), DEFAULT_STATE_DIR);
      await assertDirectoryExists(stateDir);
      const confirmed = options.yes ? true : await confirmReset();
      if (!confirmed) {
        console.log("reset cancelled.");
        return;
      }

      await Promise.all(
        RESET_TARGET_DIRNAMES.map(async (dirname) => {
          const targetPath = path.join(stateDir, dirname);
          // Remove-and-recreate keeps command behavior deterministic even when
          // target paths are missing or accidentally created as files.
          await fs.rm(targetPath, { recursive: true, force: true });
          await fs.mkdir(targetPath, { recursive: true });
        }),
      );

      console.log(`reset ${RESET_TARGET_DIRNAMES.map((dirname) => `${DEFAULT_STATE_DIR}/${dirname}`).join(", ")}`);
    });

  return cmd;
}

async function confirmResetState(input: {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
}): Promise<boolean> {
  if (!input.input.isTTY) {
    throw new Error("reset requires an interactive terminal confirmation. Use --yes to skip confirmation.");
  }

  const rl = createInterface({
    input: input.input,
    output: input.output,
  });
  try {
    const answer = await rl.question(
      "This will permanently delete .codefleet/data, .codefleet/runtime, and .codefleet/logs contents. Continue? [y/N] ",
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function assertDirectoryExists(directoryPath: string): Promise<void> {
  const stats = await fs.stat(directoryPath).catch((error) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`${path.relative(process.cwd(), directoryPath)} does not exist`);
    }
    throw error;
  });
  if (!stats.isDirectory()) {
    throw new Error(`${path.relative(process.cwd(), directoryPath)} is not a directory`);
  }
}

async function resolveGitCommitHash(): Promise<string> {
  const { stdout } = await runCommand("git", ["rev-parse", "--verify", "HEAD"]);
  const hash = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(hash)) {
    throw new Error(`unexpected git commit hash: ${hash}`);
  }
  return hash;
}

async function createZipArchive(input: {
  outputPath: string;
  sourcePath: string;
  excludePatterns: string[];
}): Promise<void> {
  const outputPath = path.resolve(input.outputPath);
  const args = ["-r", "-q", outputPath, input.sourcePath];
  for (const pattern of input.excludePatterns) {
    args.push("-x", pattern);
  }
  await runCommand("zip", args);
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().length > 0 ? stderr.trim() : `exit ${code ?? "unknown"}`;
      reject(new Error(`${command} failed: ${detail}`));
    });
  });
}
