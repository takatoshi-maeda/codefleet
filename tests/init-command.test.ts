import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitCommand } from "../src/cli/commands/init.js";

describe("init command", () => {
  const originalCwd = process.cwd();
  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  async function runInitCommand(input: { docsRepository: string; lang: string; addSubmoduleSpy?: ReturnType<typeof vi.fn> }) {
    const addSubmodule = input.addSubmoduleSpy ?? vi.fn(async () => undefined);
    const root = new Command();
    root.addCommand(
      createInitCommand({
        askRequiredQuestion: async (_message, envKey) => {
          if (envKey === "CODEFLEET_INIT_DOCS_REPOSITORY") {
            return input.docsRepository;
          }
          return input.lang;
        },
        addDocsSubmodule: addSubmodule,
      }),
    );
    await root.parseAsync(["init"], { from: "user" });
    return { addSubmodule };
  }

  it("creates .gitignore when missing, adds required entries, creates config, and adds docs submodule", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-init-"));
    process.chdir(tempDir);
    const addSubmodule = vi.fn(async () => undefined);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInitCommand({
      docsRepository: "https://github.com/example/docs-spec.git",
      lang: "ja",
      addSubmoduleSpy: addSubmodule,
    });

    const gitignore = await fs.readFile(path.join(tempDir, ".gitignore"), "utf8");
    expect(gitignore).toBe("/.codefleet/data/\n/.codefleet/runtime/\n/.codefleet/logs/\n/.codefleet/archives/\n");
    expect(logSpy).toHaveBeenCalledWith(
      "updated .gitignore: added /.codefleet/data/, /.codefleet/runtime/, /.codefleet/logs/, /.codefleet/archives/",
    );
    expect(addSubmodule).toHaveBeenCalledWith("https://github.com/example/docs-spec.git", "docs/spec");
    const config = JSON.parse(await fs.readFile(path.join(tempDir, ".codefleet", "config.json"), "utf8")) as {
      lang: string;
      docsRepository: string;
      hooks: Record<string, unknown>;
    };
    expect(config).toEqual({
      lang: "ja",
      docsRepository: "https://github.com/example/docs-spec.git",
      hooks: {
        Orchestrator: { before_start: [], after_complete: [], after_fail: [] },
        Curator: { before_start: [], after_complete: [], after_fail: [] },
        Developer: { before_start: [], after_complete: [], after_fail: [] },
        Polisher: { before_start: [], after_complete: [], after_fail: [] },
        Gatekeeper: { before_start: [], after_complete: [], after_fail: [] },
        Reviewer: { before_start: [], after_complete: [], after_fail: [] },
      },
    });
    expect(logSpy).toHaveBeenCalledWith("created .codefleet/config.json");
  });

  it("appends only missing required entries to existing .gitignore", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-init-"));
    process.chdir(tempDir);
    await fs.writeFile(path.join(tempDir, ".gitignore"), "node_modules/\n/.codefleet/runtime/\n", "utf8");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInitCommand({ docsRepository: "git@github.com:example/docs.git", lang: "en" });

    const gitignore = await fs.readFile(path.join(tempDir, ".gitignore"), "utf8");
    expect(gitignore).toBe(
      "node_modules/\n/.codefleet/runtime/\n/.codefleet/data/\n/.codefleet/logs/\n/.codefleet/archives/\n",
    );
  });

  it("does not duplicate equivalent required entries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-init-"));
    process.chdir(tempDir);
    await fs.writeFile(
      path.join(tempDir, ".gitignore"),
      ".codefleet/data\n.codefleet/runtime\n.codefleet/logs/\n.codefleet/archives\n",
      "utf8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInitCommand({ docsRepository: "https://example.com/spec.git", lang: "日本語" });

    const gitignore = await fs.readFile(path.join(tempDir, ".gitignore"), "utf8");
    expect(gitignore).toBe(".codefleet/data\n.codefleet/runtime\n.codefleet/logs/\n.codefleet/archives\n");
    expect(logSpy).toHaveBeenCalledWith(".gitignore already contains required codefleet entries");
  });
});
