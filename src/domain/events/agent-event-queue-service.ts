import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../../infra/fs/atomic-write.js";
import type { SystemEvent } from "../../events/router.js";
import { createUlid } from "../../shared/ulid.js";
import type { AgentRuntimeCollection } from "../agent-runtime-model.js";
import { getRoleEventDelivery, isRoleSubscribedToEvent } from "../agents/agent-role-definitions.js";
import type { AgentEventQueueMessage } from "./agent-event-queue-message-model.js";

const DEFAULT_RUNTIME_DIR = ".codefleet/runtime";
const AGENTS_FILE = "agents.json";
const EVENT_QUEUE_ROOT = "events/agents";

export interface AgentEventQueueEnqueueResult {
  enqueuedAgentIds: string[];
  files: string[];
}

export class AgentEventQueueService {
  constructor(private readonly runtimeDir: string = DEFAULT_RUNTIME_DIR) {}

  async enqueueToRunningAgents(event: SystemEvent): Promise<AgentEventQueueEnqueueResult> {
    const runtimes = await this.readRuntime();
    const runningAgents = runtimes.agents
      .filter((agent) => agent.status === "running" && isRoleSubscribedToEvent(agent.role, event))
      .sort((left, right) => left.id.localeCompare(right.id));

    const createdAt = new Date().toISOString();
    const files: string[] = [];

    // A per-agent spool keeps consumption independent and removes cross-agent lock contention.
    for (const agent of runningAgents) {
      const messageId = createUlid();
      const queueFilePath = path.join(
        this.runtimeDir,
        EVENT_QUEUE_ROOT,
        agent.id,
        "pending",
        `${messageId}.json`,
      );
      const message: AgentEventQueueMessage = {
        id: messageId,
        createdAt,
        agentId: agent.id,
        event,
        delivery: getRoleEventDelivery(agent.role, event),
        source: {
          command: "codefleet trigger docs.update",
        },
      };
      await atomicWriteJson(queueFilePath, message);
      files.push(queueFilePath);
    }

    return {
      enqueuedAgentIds: runningAgents.map((agent) => agent.id),
      files,
    };
  }

  private async readRuntime(): Promise<AgentRuntimeCollection> {
    const runtimeFilePath = path.join(this.runtimeDir, AGENTS_FILE);

    try {
      const raw = await fs.readFile(runtimeFilePath, "utf8");
      return JSON.parse(raw) as AgentRuntimeCollection;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return {
          version: 1,
          updatedAt: new Date(0).toISOString(),
          agents: [],
        };
      }

      throw error;
    }
  }
}
