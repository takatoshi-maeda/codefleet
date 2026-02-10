import type { SystemEvent } from "../router.js";

export interface EventSink {
  publish(event: SystemEvent): Promise<void>;
}

export class BacklogPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: EventSink,
    private readonly actor: "Developer" | "QA",
    private readonly pollIntervalMs: number = 10_000,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    void this.emitTick();
    this.timer = setInterval(() => {
      void this.emitTick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async emitTick(): Promise<void> {
    await this.sink.publish({
      type: "backlog.poll.tick",
      actor: this.actor,
      at: new Date().toISOString(),
    });
  }
}
