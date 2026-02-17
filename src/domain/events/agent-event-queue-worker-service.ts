import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentEventQueueMessage } from "./agent-event-queue-message-model.js";

const DEFAULT_RUNTIME_DIR = ".codefleet/runtime";
const EVENT_QUEUE_ROOT = "events/agents";

export interface ConsumeAgentQueueInput {
  agentId: string;
  maxMessages: number;
}

export interface ConsumeAgentQueueOptions {
  onMessage?: (message: AgentEventQueueMessage) => Promise<void>;
}

export interface ConsumeAgentQueueResult {
  consumed: number;
  doneFiles: string[];
  failedFiles: string[];
  failures: Array<{ file: string; reason: string }>;
}

export class AgentEventQueueWorkerService {
  constructor(private readonly runtimeDir: string = DEFAULT_RUNTIME_DIR) {}

  async consume(input: ConsumeAgentQueueInput, options: ConsumeAgentQueueOptions = {}): Promise<ConsumeAgentQueueResult> {
    if (!Number.isInteger(input.maxMessages) || input.maxMessages <= 0) {
      throw new Error("maxMessages must be a positive integer");
    }

    const queueDirs = this.buildQueueDirs(input.agentId);
    await fs.mkdir(queueDirs.pending, { recursive: true });
    await fs.mkdir(queueDirs.processing, { recursive: true });
    await fs.mkdir(queueDirs.done, { recursive: true });
    await fs.mkdir(queueDirs.failed, { recursive: true });

    const pendingFiles = (await fs.readdir(queueDirs.pending))
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .slice(0, input.maxMessages);

    const doneFiles: string[] = [];
    const failedFiles: string[] = [];
    const failures: Array<{ file: string; reason: string }> = [];

    for (const fileName of pendingFiles) {
      const claimed = await this.claimPendingFile(queueDirs.pending, queueDirs.processing, fileName);
      if (!claimed) {
        continue;
      }

      const processingPath = path.join(queueDirs.processing, fileName);
      try {
        const message = await validateQueueMessage(processingPath);
        if (options.onMessage) {
          await options.onMessage(message);
        }
        const donePath = path.join(queueDirs.done, fileName);
        await fs.rename(processingPath, donePath);
        doneFiles.push(donePath);
      } catch (error) {
        const failedPath = path.join(queueDirs.failed, fileName);
        await fs.rename(processingPath, failedPath);
        failedFiles.push(failedPath);
        failures.push({
          file: failedPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      consumed: doneFiles.length + failedFiles.length,
      doneFiles,
      failedFiles,
      failures,
    };
  }

  private buildQueueDirs(agentId: string): { pending: string; processing: string; done: string; failed: string } {
    const base = path.join(this.runtimeDir, EVENT_QUEUE_ROOT, agentId);
    return {
      pending: path.join(base, "pending"),
      processing: path.join(base, "processing"),
      done: path.join(base, "done"),
      failed: path.join(base, "failed"),
    };
  }

  private async claimPendingFile(pendingDir: string, processingDir: string, fileName: string): Promise<boolean> {
    const sourcePath = path.join(pendingDir, fileName);
    const processingPath = path.join(processingDir, fileName);

    try {
      await fs.rename(sourcePath, processingPath);
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}

async function validateQueueMessage(filePath: string): Promise<AgentEventQueueMessage> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("queue message must be an object");
  }

  const message = parsed as Partial<AgentEventQueueMessage>;
  if (typeof message.id !== "string" || message.id.length === 0) {
    throw new Error("queue message.id must be a non-empty string");
  }
  if (typeof message.agentId !== "string" || message.agentId.length === 0) {
    throw new Error("queue message.agentId must be a non-empty string");
  }
  if (
    message.agentRole !== "Orchestrator" &&
    message.agentRole !== "Developer" &&
    message.agentRole !== "Polisher" &&
    message.agentRole !== "Gatekeeper" &&
    message.agentRole !== "Reviewer"
  ) {
    throw new Error("queue message.agentRole must be a valid AgentRole");
  }
  if (!message.event || typeof message.event.type !== "string") {
    throw new Error("queue message.event.type must be a string");
  }
  if (message.event.type === "docs.update") {
    if (!Array.isArray(message.event.paths) || !message.event.paths.every((entry: unknown) => typeof entry === "string")) {
      throw new Error("queue message.event.paths must be string[] for docs.update");
    }
  } else if (
    message.event.type !== "acceptance-test.update" &&
    message.event.type !== "acceptance-test.required" &&
    message.event.type !== "backlog.update" &&
    message.event.type !== "backlog.epic.ready" &&
    message.event.type !== "backlog.epic.polish.ready" &&
    message.event.type !== "backlog.epic.review.ready" &&
    message.event.type !== "debug.playwright-test"
  ) {
    throw new Error("queue message.event.type must be a known SystemEvent");
  }
  if (
    (message.event.type === "backlog.epic.ready" ||
      message.event.type === "backlog.epic.polish.ready" ||
      message.event.type === "backlog.epic.review.ready") &&
    message.event.epicId !== undefined &&
    typeof message.event.epicId !== "string"
  ) {
    throw new Error("queue message.event.epicId must be string for epic-scoped events");
  }
  if (message.event.type === "backlog.epic.polish.ready" && (!message.event.epicId || message.event.epicId.length === 0)) {
    throw new Error("queue message.event.epicId is required for backlog.epic.polish.ready");
  }
  if (message.event.type === "backlog.epic.review.ready" && (!message.event.epicId || message.event.epicId.length === 0)) {
    throw new Error("queue message.event.epicId is required for backlog.epic.review.ready");
  }

  return message as AgentEventQueueMessage;
}
