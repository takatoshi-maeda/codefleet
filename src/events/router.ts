import { spawn } from "node:child_process";

export type SystemEvent =
  | { type: "docs.update"; paths: string[] }
  | { type: "source-brief.update"; briefPath: string; sourcePaths: string[] }
  | { type: "feedback-note.create"; path: string }
  | { type: "acceptance-test.update" }
  | { type: "acceptance-test.required" }
  | { type: "backlog.update" }
  | { type: "backlog.epic.ready"; epicId?: string }
  | { type: "backlog.epic.polish.ready"; epicId: string }
  | { type: "backlog.epic.review.ready"; epicId: string }
  | { type: "debug.playwright-test" };

export const SYSTEM_EVENT_TYPES: ReadonlyArray<SystemEvent["type"]> = [
  "docs.update",
  "source-brief.update",
  "feedback-note.create",
  "acceptance-test.update",
  "acceptance-test.required",
  "backlog.update",
  "backlog.epic.ready",
  "backlog.epic.polish.ready",
  "backlog.epic.review.ready",
  "debug.playwright-test",
];

export interface SystemEventCommandOptionDefinition {
  key: string;
  flags: string;
  description: string;
  required?: boolean;
  parser?: "csv-repeatable";
  summaryToken?: string;
}

export interface SystemEventCommandDefinition {
  description: string;
  options?: ReadonlyArray<SystemEventCommandOptionDefinition>;
  createEvent: (parsedOptions: Record<string, unknown>) => SystemEvent;
}

// Keep event CLI registration alongside event type modeling so adding a new
// SystemEvent naturally forces a trigger command definition in one place.
export const SYSTEM_EVENT_COMMAND_DEFINITIONS: Record<SystemEvent["type"], SystemEventCommandDefinition> = {
  "docs.update": {
    description: "SystemEvent.type=docs.update",
    options: [
      {
        key: "paths",
        flags: "--paths <path>",
        description: "Updated document path (repeatable/comma-separated)",
        required: true,
        parser: "csv-repeatable",
        summaryToken: "--paths <path> (repeatable/comma-separated)",
      },
    ],
    createEvent(parsedOptions) {
      const paths = Array.isArray(parsedOptions.paths)
        ? parsedOptions.paths.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      if (paths.length === 0) {
        throw new Error("docs.update: --paths must include at least one path");
      }
      return { type: "docs.update", paths };
    },
  },
  "source-brief.update": {
    description: "SystemEvent.type=source-brief.update",
    options: [
      {
        key: "briefPath",
        flags: "--brief-path <path>",
        description: "Project-root relative path to the curated source brief markdown file",
        required: true,
        summaryToken: "--brief-path <path>",
      },
      {
        key: "sourcePath",
        flags: "--source-path <path>",
        description: "Source document path represented by the brief (repeatable/comma-separated)",
        parser: "csv-repeatable",
        summaryToken: "--source-path <path> (repeatable/comma-separated)",
      },
    ],
    createEvent(parsedOptions) {
      const briefPath = typeof parsedOptions.briefPath === "string" ? parsedOptions.briefPath.trim() : "";
      if (briefPath.length === 0) {
        throw new Error("source-brief.update: --brief-path must be non-empty");
      }
      const sourcePaths = Array.isArray(parsedOptions.sourcePath)
        ? parsedOptions.sourcePath.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      return { type: "source-brief.update", briefPath, sourcePaths };
    },
  },
  "feedback-note.create": {
    description: "SystemEvent.type=feedback-note.create",
    options: [
      {
        key: "path",
        flags: "--path <path>",
        description: "Project-root relative path to created feedback note markdown file",
        required: true,
        summaryToken: "--path <path>",
      },
    ],
    createEvent(parsedOptions) {
      const path = typeof parsedOptions.path === "string" ? parsedOptions.path.trim() : "";
      if (path.length === 0) {
        throw new Error("feedback-note.create: --path must be non-empty");
      }
      if (path.includes("..")) {
        throw new Error("feedback-note.create: --path must not contain '..'");
      }
      if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(path)) {
        throw new Error("feedback-note.create: --path must be relative to project root");
      }
      if (!path.endsWith(".md")) {
        throw new Error("feedback-note.create: --path must end with .md");
      }
      return { type: "feedback-note.create", path };
    },
  },
  "acceptance-test.update": {
    description: "SystemEvent.type=acceptance-test.update",
    createEvent() {
      return { type: "acceptance-test.update" };
    },
  },
  "acceptance-test.required": {
    description: "SystemEvent.type=acceptance-test.required",
    createEvent() {
      return { type: "acceptance-test.required" };
    },
  },
  "backlog.update": {
    description: "SystemEvent.type=backlog.update",
    createEvent() {
      return { type: "backlog.update" };
    },
  },
  "backlog.epic.ready": {
    description: "SystemEvent.type=backlog.epic.ready",
    options: [
      {
        key: "epicId",
        flags: "--epic-id <epicId>",
        description: "Target epic id (use for review-requested rework)",
        summaryToken: "--epic-id <epicId>",
      },
    ],
    createEvent(parsedOptions) {
      const epicId = typeof parsedOptions.epicId === "string" && parsedOptions.epicId.length > 0
        ? parsedOptions.epicId
        : undefined;
      return { type: "backlog.epic.ready", epicId };
    },
  },
  "backlog.epic.polish.ready": {
    description: "SystemEvent.type=backlog.epic.polish.ready",
    options: [
      {
        key: "epicId",
        flags: "--epic-id <epicId>",
        description: "Epic id to polish for UI quality",
        required: true,
        summaryToken: "--epic-id <epicId>",
      },
    ],
    createEvent(parsedOptions) {
      const epicId = typeof parsedOptions.epicId === "string" ? parsedOptions.epicId.trim() : "";
      if (epicId.length === 0) {
        throw new Error("backlog.epic.polish.ready: --epic-id must be non-empty");
      }
      return { type: "backlog.epic.polish.ready", epicId };
    },
  },
  "backlog.epic.review.ready": {
    description: "SystemEvent.type=backlog.epic.review.ready",
    options: [
      {
        key: "epicId",
        flags: "--epic-id <epicId>",
        description: "Epic id to review",
        required: true,
        summaryToken: "--epic-id <epicId>",
      },
    ],
    createEvent(parsedOptions) {
      const epicId = typeof parsedOptions.epicId === "string" ? parsedOptions.epicId.trim() : "";
      if (epicId.length === 0) {
        throw new Error("backlog.epic.review.ready: --epic-id must be non-empty");
      }
      return { type: "backlog.epic.review.ready", epicId };
    },
  },
  "debug.playwright-test": {
    description: "SystemEvent.type=debug.playwright-test",
    createEvent() {
      return { type: "debug.playwright-test" };
    },
  },
};

export interface CommandExecution {
  executable: string;
  args: string[];
}

export interface CommandDispatcher {
  dispatch(executable: string, args: string[]): Promise<void>;
}

export function createCodefleetCommandDispatcher(): CommandDispatcher {
  return {
    dispatch(executable, args) {
      return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(`command failed: ${executable} ${args.join(" ")} (exit ${code ?? "unknown"})`));
        });
      });
    },
  };
}

export interface EventRouterOptions {
  dedupeWindowMs?: number;
}

export interface RouteResult {
  deduped: boolean;
  executions: CommandExecution[];
}

// Event sources can emit duplicates (fs watchers, polling, manual retries),
// so routing is deduplicated in a short in-memory window to keep handlers idempotent
// without requiring every downstream command to implement its own dedupe logic.
const DEFAULT_DEDUPE_WINDOW_MS = 30_000;

export class EventRouter {
  private readonly dedupeWindowMs: number;
  private readonly handledEvents = new Map<string, number>();

  constructor(
    private readonly dispatcher: CommandDispatcher,
    options: EventRouterOptions = {},
  ) {
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  }

  async route(event: SystemEvent): Promise<RouteResult> {
    const dedupeKey = this.createDedupeKey(event);
    this.pruneStaleEntries();

    const now = Date.now();
    const previous = this.handledEvents.get(dedupeKey);
    if (previous && now - previous < this.dedupeWindowMs) {
      return { deduped: true, executions: [] };
    }

    const executions = this.mapToExecutions(event);
    for (const execution of executions) {
      await this.dispatcher.dispatch(execution.executable, execution.args);
    }

    this.handledEvents.set(dedupeKey, now);
    return { deduped: false, executions };
  }

  private mapToExecutions(event: SystemEvent): CommandExecution[] {
    return [{ executable: "codefleet-acceptance-test", args: ["list"] }];
  }

  private createDedupeKey(event: SystemEvent): string {
    if (event.type !== "docs.update") {
      return event.type;
    }
    // Order-independent key avoids duplicate processing when the same path set arrives in a different order.
    return `${event.type}:${[...event.paths].sort().join("|")}`;
  }

  private pruneStaleEntries(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.handledEvents) {
      if (now - timestamp > this.dedupeWindowMs) {
        this.handledEvents.delete(key);
      }
    }
  }
}
