import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriggerCommand } from "../src/cli/commands/trigger.js";
import type { RouteResult, SystemEvent } from "../src/events/router.js";

class RecordingRouter {
  public events: SystemEvent[] = [];

  async route(event: SystemEvent): Promise<RouteResult> {
    this.events.push(event);
    return { deduped: false, executions: [] };
  }
}

describe("trigger command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows event subcommands and their params via --help", async () => {
    const command = createTriggerCommand();
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

    await expect(command.parseAsync(["--help"], { from: "user" })).rejects.toBeDefined();

    expect(output).toContain("docs.update");
    expect(output).toContain("--paths <path> (repeatable/comma-separated)");
    expect(output).not.toContain("docs.update [options]");
  });

  it("shows docs.update params via subcommand --help", async () => {
    const command = createTriggerCommand();
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

    await expect(command.parseAsync(["docs.update", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("--paths <path>");
  });

  it("builds docs.update event from --paths option values", async () => {
    const router = new RecordingRouter();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router }).parseAsync(
      ["docs.update", "--paths", "docs/a.md,docs/b.md", "--paths", "docs/c.md"],
      { from: "user" },
    );

    expect(router.events).toEqual([
      {
        type: "docs.update",
        paths: ["docs/a.md", "docs/b.md", "docs/c.md"],
      },
    ]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("rejects unknown event subcommand", async () => {
    const router = new RecordingRouter();
    const command = createTriggerCommand({ router }).exitOverride();

    await expect(
      command.parseAsync(["manual.triggered", "--actor", "Developer"], { from: "user" }),
    ).rejects.toThrow(/unknown command 'manual\.triggered'/u);
  });
});
