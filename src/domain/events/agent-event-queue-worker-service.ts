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
      } catch {
        const failedPath = path.join(queueDirs.failed, fileName);
        await fs.rename(processingPath, failedPath);
        failedFiles.push(failedPath);
      }
    }

    return {
      consumed: doneFiles.length + failedFiles.length,
      doneFiles,
      failedFiles,
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
    !message.event ||
    typeof message.event.type !== "string" ||
    !Array.isArray(message.event.paths) ||
    !message.event.paths.every((entry) => typeof entry === "string")
  ) {
    throw new Error("queue message.event must include type and string paths");
  }
  if (!message.delivery || typeof message.delivery !== "object") {
    throw new Error("queue message.delivery must be an object");
  }
  if (
    message.delivery.promptFile !== undefined &&
    (typeof message.delivery.promptFile !== "string" || message.delivery.promptFile.length === 0)
  ) {
    throw new Error("queue message.delivery.promptFile must be a non-empty string when provided");
  }

  return message as AgentEventQueueMessage;
}
