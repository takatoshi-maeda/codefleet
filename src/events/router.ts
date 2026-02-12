import { spawn } from "node:child_process";

export type SystemEvent =
  | { type: "docs.update"; paths: string[] };

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
