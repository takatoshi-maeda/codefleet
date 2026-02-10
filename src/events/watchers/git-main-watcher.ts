import { promises as fs } from "node:fs";
import path from "node:path";
import type { SystemEvent } from "../router.js";

export interface EventSink {
  publish(event: SystemEvent): Promise<void>;
}

export class GitMainWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastCommit: string | null = null;

  constructor(
    private readonly sink: EventSink,
    private readonly repositoryRoot: string = process.cwd(),
    private readonly pollIntervalMs: number = 5_000,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const commit = await this.readMainCommit();
    if (!commit || commit === this.lastCommit) {
      return;
    }

    this.lastCommit = commit;
    await this.sink.publish({ type: "git.main.updated", commit });
  }

  private async readMainCommit(): Promise<string | null> {
    const headRefPath = path.join(this.repositoryRoot, ".git", "refs", "heads", "main");

    try {
      const content = await fs.readFile(headRefPath, "utf8");
      return content.trim() || null;
    } catch {
      return null;
    }
  }
}
