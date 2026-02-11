import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCli } from "../src/cli/index.js";

describe("init command", () => {
  const originalCwd = process.cwd();

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("creates .gitignore when missing and adds codefleet data ignore entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-init-"));
    process.chdir(tempDir);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await createCli().parseAsync(["init"], { from: "user" });

    const gitignore = await fs.readFile(path.join(tempDir, ".gitignore"), "utf8");
    expect(gitignore).toBe("/.codefleet/data/\n");
    expect(logSpy).toHaveBeenCalledWith("updated .gitignore: added /.codefleet/data/");
  });

  it("appends codefleet data ignore entry to existing .gitignore", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-init-"));
    process.chdir(tempDir);
    await fs.writeFile(path.join(tempDir, ".gitignore"), "node_modules/\n", "utf8");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await createCli().parseAsync(["init"], { from: "user" });

    const gitignore = await fs.readFile(path.join(tempDir, ".gitignore"), "utf8");
    expect(gitignore).toBe("node_modules/\n/.codefleet/data/\n");
  });

  it("does not duplicate equivalent ignore entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-init-"));
    process.chdir(tempDir);
    await fs.writeFile(path.join(tempDir, ".gitignore"), ".codefleet/data\n", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await createCli().parseAsync(["init"], { from: "user" });

    const gitignore = await fs.readFile(path.join(tempDir, ".gitignore"), "utf8");
    expect(gitignore).toBe(".codefleet/data\n");
    expect(logSpy).toHaveBeenCalledWith(".gitignore already contains /.codefleet/data/");
  });
});
