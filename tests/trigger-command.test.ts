import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriggerCommand } from "../src/cli/commands/trigger.js";
import type { RouteResult, SystemEvent } from "../src/events/router.js";
import type { AgentEventQueueEnqueueResult } from "../src/domain/events/agent-event-queue-service.js";

class RecordingRouter {
  public events: SystemEvent[] = [];

  async route(event: SystemEvent): Promise<RouteResult> {
    this.events.push(event);
    return { deduped: false, executions: [] };
  }
}

class RecordingQueue {
  public events: SystemEvent[] = [];

  async enqueueToRunningAgents(event: SystemEvent): Promise<AgentEventQueueEnqueueResult> {
    this.events.push(event);
    return { enqueuedAgentIds: ["developer-1"], files: [".codefleet/runtime/events/agents/developer-1/pending/a.json"] };
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
    expect(output).toContain("source-brief.update");
    expect(output).toContain("feedback-note.create");
    expect(output).toContain("acceptance-test.update");
    expect(output).toContain("acceptance-test.required");
    expect(output).toContain("backlog.update");
    expect(output).toContain("backlog.epic.ready");
    expect(output).toContain("backlog.epic.polish.ready");
    expect(output).toContain("backlog.epic.review.ready");
    expect(output).toContain("debug.playwright-test");
    expect(output).toContain("--paths <path> (repeatable/comma-separated)");
    expect(output).toContain("--brief-path <path>");
    expect(output).toContain("--path <path>");
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
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(
      ["docs.update", "--paths", "docs/a.md,docs/b.md", "--paths", "docs/c.md"],
      { from: "user" },
    );

    expect(router.events).toEqual([
      {
        type: "docs.update",
        paths: ["docs/a.md", "docs/b.md", "docs/c.md"],
      },
    ]);
    expect(queue.events).toEqual([
      {
        type: "docs.update",
        paths: ["docs/a.md", "docs/b.md", "docs/c.md"],
      },
    ]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds acceptance-test.update event with no options", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["acceptance-test.update"], { from: "user" });

    expect(router.events).toEqual([{ type: "acceptance-test.update" }]);
    expect(queue.events).toEqual([{ type: "acceptance-test.update" }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds source-brief.update event with brief path and source paths", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(
      [
        "source-brief.update",
        "--brief-path",
        ".codefleet/data/source-brief/latest.md",
        "--source-path",
        "docs/spec,docs/requirements.md",
      ],
      { from: "user" },
    );

    expect(router.events).toEqual([
      {
        type: "source-brief.update",
        briefPath: ".codefleet/data/source-brief/latest.md",
        sourcePaths: ["docs/spec", "docs/requirements.md"],
      },
    ]);
    expect(queue.events).toEqual(router.events);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds feedback-note.create event with --path", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(
      ["feedback-note.create", "--path", ".codefleet/data/feedback-notes/01HXTEST0000000000000000.md"],
      { from: "user" },
    );

    expect(router.events).toEqual([
      { type: "feedback-note.create", path: ".codefleet/data/feedback-notes/01HXTEST0000000000000000.md" },
    ]);
    expect(queue.events).toEqual([
      { type: "feedback-note.create", path: ".codefleet/data/feedback-notes/01HXTEST0000000000000000.md" },
    ]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("rejects feedback-note.create when --path is invalid", async () => {
    const command = createTriggerCommand({ router: new RecordingRouter(), queue: new RecordingQueue() }).exitOverride();

    await expect(command.parseAsync(["feedback-note.create", "--path", "../secret.md"], { from: "user" })).rejects.toThrow(
      /must not contain '\.\.'/u,
    );
  });

  it("builds acceptance-test.required event with no options", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["acceptance-test.required"], { from: "user" });

    expect(router.events).toEqual([{ type: "acceptance-test.required" }]);
    expect(queue.events).toEqual([{ type: "acceptance-test.required" }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds backlog.update event with no options", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["backlog.update"], { from: "user" });

    expect(router.events).toEqual([{ type: "backlog.update" }]);
    expect(queue.events).toEqual([{ type: "backlog.update" }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds backlog.epic.ready event with no options", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["backlog.epic.ready"], { from: "user" });

    expect(router.events).toEqual([{ type: "backlog.epic.ready", epicId: undefined }]);
    expect(queue.events).toEqual([{ type: "backlog.epic.ready", epicId: undefined }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds backlog.epic.ready event with --epic-id option", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["backlog.epic.ready", "--epic-id", "E-123"], {
      from: "user",
    });

    expect(router.events).toEqual([{ type: "backlog.epic.ready", epicId: "E-123" }]);
    expect(queue.events).toEqual([{ type: "backlog.epic.ready", epicId: "E-123" }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds backlog.epic.review.ready event with --epic-id", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["backlog.epic.review.ready", "--epic-id", "E-123"], {
      from: "user",
    });

    expect(router.events).toEqual([{ type: "backlog.epic.review.ready", epicId: "E-123" }]);
    expect(queue.events).toEqual([{ type: "backlog.epic.review.ready", epicId: "E-123" }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds backlog.epic.polish.ready event with --epic-id", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["backlog.epic.polish.ready", "--epic-id", "E-222"], {
      from: "user",
    });

    expect(router.events).toEqual([{ type: "backlog.epic.polish.ready", epicId: "E-222" }]);
    expect(queue.events).toEqual([{ type: "backlog.epic.polish.ready", epicId: "E-222" }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("builds debug.playwright-test event with no options", async () => {
    const router = new RecordingRouter();
    const queue = new RecordingQueue();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createTriggerCommand({ router, queue }).parseAsync(["debug.playwright-test"], { from: "user" });

    expect(router.events).toEqual([{ type: "debug.playwright-test" }]);
    expect(queue.events).toEqual([{ type: "debug.playwright-test" }]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("rejects unknown event subcommand", async () => {
    const router = new RecordingRouter();
    const command = createTriggerCommand({ router, queue: new RecordingQueue() }).exitOverride();

    await expect(
      command.parseAsync(["manual.triggered", "--actor", "Developer"], { from: "user" }),
    ).rejects.toThrow(/unknown command 'manual\.triggered'/u);
  });
});
