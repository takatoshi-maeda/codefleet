import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BacklogPoller } from "../src/events/watchers/backlog-poller.js";
import { GitMainWatcher } from "../src/events/watchers/git-main-watcher.js";
import { ResultFileWatcher } from "../src/events/watchers/result-file-watcher.js";
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
  it("emits git.main.updated when main ref changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-git-watch-"));
    await fs.mkdir(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });

    const sink = new RecordingSink();
    const watcher = new GitMainWatcher(sink, tempDir, 20);
    watcher.start();

    await fs.writeFile(path.join(tempDir, ".git", "refs", "heads", "main"), "commit-a\n", "utf8");
    await sleep(60);

    watcher.stop();

    expect(sink.events.some((event) => event.type === "git.main.updated" && event.commit === "commit-a")).toBe(true);
  });

  it("emits acceptance.result.created for new result files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-result-watch-"));
    const resultsDir = path.join(tempDir, "results");
    await fs.mkdir(resultsDir, { recursive: true });

    const sink = new RecordingSink();
    const watcher = new ResultFileWatcher(sink, resultsDir, 20);
    watcher.start();

    await fs.writeFile(path.join(resultsDir, "ATR-20260101-001.json"), "{}", "utf8");
    await sleep(60);

    watcher.stop();

    expect(
      sink.events.some(
        (event) => event.type === "acceptance.result.created" && event.path.endsWith("ATR-20260101-001.json"),
      ),
    ).toBe(true);
  });

  it("emits backlog.poll.tick repeatedly", async () => {
    const sink = new RecordingSink();
    const poller = new BacklogPoller(sink, "Developer", 20);
    poller.start();

    await sleep(70);
    poller.stop();

    expect(sink.events.filter((event) => event.type === "backlog.poll.tick").length).toBeGreaterThanOrEqual(2);
  });
});
