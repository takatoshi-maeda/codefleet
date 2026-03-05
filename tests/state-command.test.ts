import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateCommand } from "../src/cli/commands/state.js";

describe("state command", () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
  });

  it("archives .codefleet state into .codefleet/archives/<hash>.zip", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codefleet-state-archive-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);
    await mkdir(path.join(tempDir, ".codefleet", "runtime"), { recursive: true });

    const resolveGitCommitHash = vi.fn(async () => "0123456789abcdef0123456789abcdef01234567");
    const createZipArchive = vi.fn(async () => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const root = new Command();
    root.addCommand(createStateCommand({ resolveGitCommitHash, createZipArchive }));
    await root.parseAsync(["state", "archive"], { from: "user" });

    expect(resolveGitCommitHash).toHaveBeenCalledTimes(1);
    expect(createZipArchive).toHaveBeenCalledWith({
      outputPath: path.join(tempDir, ".codefleet", "archives", "0123456789abcdef0123456789abcdef01234567.zip"),
      sourcePath: ".codefleet",
      excludePatterns: [".codefleet/archives", ".codefleet/archives/*"],
    });
    expect(logSpy).toHaveBeenCalledWith(
      "created .codefleet/archives/0123456789abcdef0123456789abcdef01234567.zip",
    );
  });

  it("fails when .codefleet directory is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codefleet-state-archive-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    const root = new Command();
    root.addCommand(createStateCommand({ resolveGitCommitHash: async () => "unused", createZipArchive: async () => undefined }));

    await expect(root.parseAsync(["state", "archive"], { from: "user" })).rejects.toThrow(".codefleet does not exist");
  });

  it("resets data/runtime/logs contents while keeping target directories", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codefleet-state-reset-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    await mkdir(path.join(tempDir, ".codefleet", "data", "nested"), { recursive: true });
    await mkdir(path.join(tempDir, ".codefleet", "runtime", "events"), { recursive: true });
    await mkdir(path.join(tempDir, ".codefleet", "logs"), { recursive: true });
    await mkdir(path.join(tempDir, ".codefleet", "archives"), { recursive: true });
    await writeFile(path.join(tempDir, ".codefleet", "data", "nested", "entry.json"), "{\"ok\":true}\n", "utf8");
    await writeFile(path.join(tempDir, ".codefleet", "runtime", "events", "pending.json"), "{\"pending\":1}\n", "utf8");
    await writeFile(path.join(tempDir, ".codefleet", "logs", "fleet.log"), "line\n", "utf8");
    await writeFile(path.join(tempDir, ".codefleet", "archives", "keep.txt"), "keep\n", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = new Command();
    root.addCommand(createStateCommand());

    await root.parseAsync(["state", "reset", "--yes"], { from: "user" });

    await expect(readFile(path.join(tempDir, ".codefleet", "archives", "keep.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(readFile(path.join(tempDir, ".codefleet", "data", "nested", "entry.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(tempDir, ".codefleet", "runtime", "events", "pending.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(tempDir, ".codefleet", "logs", "fleet.log"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(tempDir, ".codefleet", "data")).then((stats) => stats.isDirectory())).resolves.toBe(true);
    await expect(stat(path.join(tempDir, ".codefleet", "runtime")).then((stats) => stats.isDirectory())).resolves.toBe(true);
    await expect(stat(path.join(tempDir, ".codefleet", "logs")).then((stats) => stats.isDirectory())).resolves.toBe(true);

    expect(logSpy).toHaveBeenCalledWith("reset .codefleet/data, .codefleet/runtime, .codefleet/logs");
  });

  it("fails on reset when .codefleet directory is missing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codefleet-state-reset-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    const root = new Command();
    root.addCommand(createStateCommand());

    await expect(root.parseAsync(["state", "reset"], { from: "user" })).rejects.toThrow(".codefleet does not exist");
  });

  it("cancels reset when confirmation is declined", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codefleet-state-reset-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);

    await mkdir(path.join(tempDir, ".codefleet", "data"), { recursive: true });
    await writeFile(path.join(tempDir, ".codefleet", "data", "entry.json"), "{\"ok\":true}\n", "utf8");

    const confirmReset = vi.fn(async () => false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const root = new Command();
    root.addCommand(createStateCommand({ confirmReset }));

    await root.parseAsync(["state", "reset"], { from: "user" });

    await expect(readFile(path.join(tempDir, ".codefleet", "data", "entry.json"), "utf8")).resolves.toBe("{\"ok\":true}\n");
    expect(confirmReset).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("reset cancelled.");
  });

  it("requires --yes for reset in non-interactive environments", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codefleet-state-reset-"));
    tempDirs.push(tempDir);
    process.chdir(tempDir);
    await mkdir(path.join(tempDir, ".codefleet"), { recursive: true });

    const root = new Command();
    root.addCommand(createStateCommand());

    await expect(root.parseAsync(["state", "reset"], { from: "user" })).rejects.toThrow(
      "reset requires an interactive terminal confirmation. Use --yes to skip confirmation.",
    );
  });
});
