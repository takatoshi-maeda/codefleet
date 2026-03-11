import { describe, expect, it } from "vitest";
import { EventRouter, type CommandExecution } from "../src/events/router.js";

class RecordingDispatcher {
  public executions: CommandExecution[] = [];

  async dispatch(executable: string, args: string[]): Promise<void> {
    this.executions.push({ executable, args });
  }
}

describe("EventRouter", () => {
  it("routes release-plan.create events to expected commands", async () => {
    const dispatcher = new RecordingDispatcher();
    const router = new EventRouter(dispatcher, { dedupeWindowMs: 1_000 });

    await router.route({ type: "release-plan.create", path: ".codefleet/data/release-plan/plan-a.md" });

    expect(dispatcher.executions).toEqual([
      { executable: "codefleet-acceptance-test", args: ["list"] },
    ]);
  });

  it("deduplicates duplicate events in dedupe window", async () => {
    const dispatcher = new RecordingDispatcher();
    const router = new EventRouter(dispatcher, { dedupeWindowMs: 5_000 });

    const first = await router.route({ type: "release-plan.create", path: ".codefleet/data/release-plan/plan-a.md" });
    const second = await router.route({ type: "release-plan.create", path: ".codefleet/data/release-plan/plan-a.md" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(dispatcher.executions).toHaveLength(1);
  });
});
