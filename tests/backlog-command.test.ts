import { afterEach, describe, expect, it, vi } from "vitest";
import { createBacklogCli } from "../src/cli/codefleet-backlog.js";

describe("backlog command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints role-specific guidance with --help-for-agent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createBacklogCli().parseAsync(["--help-for-agent"], { from: "user" });

    const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Orchestrator");
    expect(output).toContain("Developer");
    expect(output).toContain("Gatekeeper");
    expect(output).toContain("codefleet-backlog epic add");
    expect(output).toContain("codefleet-backlog item update");
    expect(output).toContain("codefleet-backlog question add");
    expect(output).toContain("codefleet-backlog question answer");
    expect(output).not.toContain("codefleet codefleet-backlog");
  });

  it("shows question subcommands in help", async () => {
    const command = createBacklogCli();
    let output = "";
    command
      .exitOverride()
      .configureOutput({
        writeOut: (str) => {
          output += str;
        },
        writeErr: (str) => {
          output += str;
        },
      });

    await expect(command.parseAsync(["question", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("add");
    expect(output).toContain("list");
    expect(output).toContain("update");
    expect(output).toContain("answer");
    expect(output).toContain("delete");
  });

  it("shows epic ready subcommand in help", async () => {
    const command = createBacklogCli();
    let output = "";
    command
      .exitOverride()
      .configureOutput({
        writeOut: (str) => {
          output += str;
        },
        writeErr: (str) => {
          output += str;
        },
      });

    await expect(command.parseAsync(["epic", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("ready");
    expect(output).toContain("read");

    output = "";
    await expect(command.parseAsync(["epic", "list", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("--kind <kind>");

    output = "";
    await expect(command.parseAsync(["item", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("read");

    output = "";
    await expect(command.parseAsync(["item", "list", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("--epic-id <epicId>");
  });

  it("shows requirements subcommands in help", async () => {
    const command = createBacklogCli();
    let output = "";
    command
      .exitOverride()
      .configureOutput({
        writeOut: (str) => {
          output += str;
        },
        writeErr: (str) => {
          output += str;
        },
      });

    await expect(command.parseAsync(["requirements", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("write");
    expect(output).toContain("read");
  });
});
