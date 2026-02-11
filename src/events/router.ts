import { spawn } from "node:child_process";

export type SystemEvent =
  | { type: "manual.triggered"; actor: "Orchestrator" | "Gatekeeper" | "Developer" }
  | { type: "git.main.updated"; commit: string }
  | { type: "acceptance.result.created"; path: string }
  | { type: "backlog.poll.tick"; actor: "Developer" | "Gatekeeper"; at: string }
  | { type: "fleet.lifecycle.changed"; status: "starting" | "running" | "stopped" | "degraded" };

export interface CommandExecution {
  command: string;
  args: string[];
}

export interface CommandDispatcher {
  dispatch(command: string, args: string[]): Promise<void>;
}

export function createBuildfleetCommandDispatcher(binary: string = "buildfleet"): CommandDispatcher {
  return {
    dispatch(command, args) {
      return new Promise((resolve, reject) => {
        const child = spawn(binary, [command, ...args], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(new Error(`command failed: ${binary} ${command} ${args.join(" ")} (exit ${code ?? "unknown"})`));
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
      await this.dispatcher.dispatch(execution.command, execution.args);
    }

    this.handledEvents.set(dedupeKey, now);
    return { deduped: false, executions };
  }

  private mapToExecutions(event: SystemEvent): CommandExecution[] {
    switch (event.type) {
      case "manual.triggered":
      case "git.main.updated":
        return [{ command: "acceptance-test", args: ["list"] }];
      case "acceptance.result.created":
        return [{ command: "backlog", args: ["list"] }];
      case "backlog.poll.tick":
        return [{ command: "backlog", args: ["list", "--status", "wait-implementation"] }];
      case "fleet.lifecycle.changed":
        return [{ command: "fleetctl", args: ["status"] }];
      default: {
        const neverEvent: never = event;
        throw new Error(`unsupported event: ${JSON.stringify(neverEvent)}`);
      }
    }
  }

  private createDedupeKey(event: SystemEvent): string {
    switch (event.type) {
      case "manual.triggered":
        return `${event.type}:${event.actor}`;
      case "git.main.updated":
        return `${event.type}:${event.commit}`;
      case "acceptance.result.created":
        return `${event.type}:${event.path}`;
      case "backlog.poll.tick":
        return `${event.type}:${event.actor}:${event.at}`;
      case "fleet.lifecycle.changed":
        return `${event.type}:${event.status}`;
      default: {
        const neverEvent: never = event;
        throw new Error(`unsupported event: ${JSON.stringify(neverEvent)}`);
      }
    }
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
