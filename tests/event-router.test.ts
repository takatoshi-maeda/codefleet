import { describe, expect, it } from "vitest";
import { EventRouter, type CommandExecution } from "../src/events/router.js";

class RecordingDispatcher {
  public executions: CommandExecution[] = [];

  async dispatch(executable: string, args: string[]): Promise<void> {
    this.executions.push({ executable, args });
  }
}

describe("EventRouter", () => {
  it("routes docs.update events to expected commands", async () => {
    const dispatcher = new RecordingDispatcher();
    const router = new EventRouter(dispatcher, { dedupeWindowMs: 1_000 });

    await router.route({ type: "docs.update", paths: ["docs/requirements.md", "docs/backlog.md"] });

    expect(dispatcher.executions).toEqual([
      { executable: "codefleet-acceptance-test", args: ["list"] },
    ]);
  });

  it("deduplicates duplicate events in dedupe window", async () => {
    const dispatcher = new RecordingDispatcher();
    const router = new EventRouter(dispatcher, { dedupeWindowMs: 5_000 });

    const first = await router.route({ type: "docs.update", paths: ["docs/spec.md", "docs/backlog.md"] });
    const second = await router.route({ type: "docs.update", paths: ["docs/backlog.md", "docs/spec.md"] });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(dispatcher.executions).toHaveLength(1);
  });
});
