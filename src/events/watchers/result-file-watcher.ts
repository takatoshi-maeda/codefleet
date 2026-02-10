import { promises as fs } from "node:fs";
import path from "node:path";
import type { SystemEvent } from "../router.js";

export interface EventSink {
  publish(event: SystemEvent): Promise<void>;
}

export class ResultFileWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly knownFiles = new Set<string>();

  constructor(
    private readonly sink: EventSink,
    private readonly resultsDir: string = path.join(process.cwd(), ".buildfleet", "data", "acceptance-testing", "results"),
    private readonly pollIntervalMs: number = 3_000,
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
    let files: string[] = [];

    try {
      files = await fs.readdir(this.resultsDir);
    } catch {
      return;
    }

    const jsonFiles = files.filter((file) => file.endsWith(".json")).sort();
    for (const file of jsonFiles) {
      if (this.knownFiles.has(file)) {
        continue;
      }

      this.knownFiles.add(file);
      await this.sink.publish({ type: "acceptance.result.created", path: path.join(this.resultsDir, file) });
    }
  }
}
