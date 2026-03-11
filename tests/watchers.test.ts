import { afterEach, describe, expect, it } from "vitest";
import { BacklogPoller } from "../src/events/watchers/backlog-poller.js";
import type { SystemEvent } from "../src/events/router.js";

class RecordingSink {
  public events: SystemEvent[] = [];

  async publish(event: SystemEvent): Promise<void> {
    this.events.push(event);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await sleep(10);
});

describe("watchers", () => {
  it("emits backlog.epic.ready repeatedly when ready epics exist", async () => {
    const sink = new RecordingSink();
    const poller = new BacklogPoller(
      sink,
      20,
      {
        async hasReadyEpic() {
          return true;
        },
        async isAcceptanceTestRunRequired() {
          return false;
        },
      },
    );
    poller.start();

    await sleep(70);
    poller.stop();

    expect(
      sink.events.filter((event) => event.type === "backlog.epic.ready").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not emit backlog.epic.ready when ready epics do not exist", async () => {
    const sink = new RecordingSink();
    const poller = new BacklogPoller(
      sink,
      20,
      {
        async hasReadyEpic() {
          return false;
        },
        async isAcceptanceTestRunRequired() {
          return false;
        },
      },
    );
    poller.start();

    await sleep(70);
    poller.stop();

    expect(sink.events).toEqual([]);
  });

  it("emits acceptance-test.required repeatedly when all epics are done and tests are not-run", async () => {
    const sink = new RecordingSink();
    const poller = new BacklogPoller(
      sink,
      20,
      {
        async hasReadyEpic() {
          return false;
        },
        async isAcceptanceTestRunRequired() {
          return true;
        },
      },
    );
    poller.start();

    await sleep(70);
    poller.stop();

    expect(
      sink.events.filter((event) => event.type === "acceptance-test.required").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
