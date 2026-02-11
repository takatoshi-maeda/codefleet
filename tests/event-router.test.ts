import { describe, expect, it } from "vitest";
import { EventRouter, type CommandExecution } from "../src/events/router.js";

class RecordingDispatcher {
  public executions: CommandExecution[] = [];

  async dispatch(command: string, args: string[]): Promise<void> {
    this.executions.push({ command, args });
  }
}

describe("EventRouter", () => {
  it("routes known events to expected commands", async () => {
    const dispatcher = new RecordingDispatcher();
    const router = new EventRouter(dispatcher, { dedupeWindowMs: 1_000 });

    await router.route({ type: "manual.triggered", actor: "Orchestrator" });
    await router.route({ type: "git.main.updated", commit: "abc123" });
    await router.route({ type: "acceptance.result.created", path: "/tmp/ATR-1.json" });
    await router.route({ type: "backlog.poll.tick", actor: "Developer", at: "2026-01-01T00:00:00.000Z" });
    await router.route({ type: "fleet.lifecycle.changed", status: "running" });

    expect(dispatcher.executions).toEqual([
      { command: "acceptance-test", args: ["list"] },
      { command: "acceptance-test", args: ["list"] },
      { command: "backlog", args: ["list"] },
      { command: "backlog", args: ["list", "--status", "wait-implementation"] },
      { command: "fleetctl", args: ["status"] },
    ]);
  });

  it("deduplicates duplicate events in dedupe window", async () => {
    const dispatcher = new RecordingDispatcher();
    const router = new EventRouter(dispatcher, { dedupeWindowMs: 5_000 });

    const first = await router.route({ type: "git.main.updated", commit: "abc123" });
    const second = await router.route({ type: "git.main.updated", commit: "abc123" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(dispatcher.executions).toHaveLength(1);
  });
});
