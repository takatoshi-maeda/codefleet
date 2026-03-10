import { afterEach, describe, expect, it, vi } from "vitest";
import { createBacklogCli } from "../src/cli/codefleet-backlog.js";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";

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
    expect(output).toContain("Polisher");
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
    await expect(command.parseAsync(["epic", "ready", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).not.toContain("--status <status>");

    output = "";
    await expect(command.parseAsync(["item", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("read");

    output = "";
    await expect(command.parseAsync(["item", "list", "--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("--epic-id <epicId>");
  });

  it("shows update-status-all-todo in top-level help", async () => {
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

    await expect(command.parseAsync(["--help"], { from: "user" })).rejects.toBeDefined();
    expect(output).toContain("update-status-all-todo");
  });

  it("updates all epic/item statuses to todo", async () => {
    const payload = { updatedEpicIds: ["E-001"], updatedItemIds: ["I-001"] };
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateStatusAllTodo").mockResolvedValue(payload);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createBacklogCli().parseAsync(["update-status-all-todo", "--actor-id", "pm-agent"], { from: "user" });

    expect(updateSpy).toHaveBeenCalledWith("pm-agent");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(payload, null, 2));
  });

  it("passes development scopes to epic add and update", async () => {
    const addSpy = vi.spyOn(BacklogService.prototype, "addEpic").mockResolvedValue({
      id: "E-001",
      title: "Scoped epic",
      kind: "product",
      developmentScopes: ["frontend", "backend", "other"],
      notes: [],
      status: "todo",
      statusChangeHistory: [],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-10T00:00:00.000Z",
    });
    const updateSpy = vi.spyOn(BacklogService.prototype, "updateEpic").mockResolvedValue({
      id: "E-001",
      title: "Scoped epic",
      kind: "product",
      developmentScopes: ["backend"],
      notes: [],
      status: "todo",
      statusChangeHistory: [],
      visibility: { type: "always-visible", dependsOnEpicIds: [] },
      acceptanceTestIds: [],
      updatedAt: "2026-03-10T00:00:00.000Z",
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createBacklogCli().parseAsync(
      [
        "epic",
        "add",
        "--title",
        "Scoped epic",
        "--development-scope",
        "frontend",
        "--development-scope",
        "backend",
        "--development-scope",
        "other",
      ],
      { from: "user" },
    );
    await createBacklogCli().parseAsync(
      ["epic", "update", "--id", "E-001", "--development-scope", "backend"],
      { from: "user" },
    );

    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ developmentScopes: ["frontend", "backend", "other"] }));
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "E-001", developmentScopes: ["backend"] }));
  });
});
