import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const FIXTURE_PREFIX = "codefleet-bin-signal-";
const WRAPPER_RELATIVE_PATH = path.join("bin", "codefleet");
const DIST_ENTRY_RELATIVE_PATH = path.join("dist", "cli", "codefleet.js");
const wrapperSourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", WRAPPER_RELATIVE_PATH);
const tempDirs: string[] = [];

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ExitResult> {
  return new Promise<ExitResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`wrapper process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function createWrapperFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX));
  tempDirs.push(root);
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "dist", "cli"), { recursive: true });

  const wrapperScript = await readFile(wrapperSourcePath, "utf8");
  await writeFile(path.join(root, WRAPPER_RELATIVE_PATH), wrapperScript, "utf8");

  await writeFile(
    path.join(root, DIST_ENTRY_RELATIVE_PATH),
    [
      "const fallbackTimer = setTimeout(() => {",
      "  process.stdout.write('child timed out\\\\n');",
      "  process.exit(91);",
      "}, 1_000);",
      "",
      "process.on('SIGINT', () => {",
      "  clearTimeout(fallbackTimer);",
      "  process.stdout.write('child received SIGINT\\\\n');",
      "  setTimeout(() => process.exit(0), 20);",
      "});",
      "",
      "setInterval(() => {}, 10_000);",
      "",
    ].join("\n"),
    "utf8",
  );

  return root;
}

describe("bin/codefleet signal forwarding", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await rm(dir, { recursive: true, force: true });
      }),
    );
  });

  it("forwards SIGINT to the CLI child process when only the wrapper receives it", async () => {
    const fixtureRoot = await createWrapperFixture();
    const wrapperPath = path.join(fixtureRoot, WRAPPER_RELATIVE_PATH);
    const child = spawn(process.execPath, [wrapperPath], {
      cwd: fixtureRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      child.kill("SIGINT");

      const exit = await waitForExit(child, 3_000);

      expect(stdout).toContain("child received SIGINT");
      expect(stdout).not.toContain("child timed out");
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
});
