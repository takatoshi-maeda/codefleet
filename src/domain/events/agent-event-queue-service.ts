import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../../infra/fs/atomic-write.js";
import type { SystemEvent } from "../../events/router.js";
import { createUlid } from "../../shared/ulid.js";
import type { AgentRuntimeCollection } from "../agent-runtime-model.js";
import { isRoleSubscribedToEvent } from "../fleet/agent-role-definitions.js";
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
    const targetAgents = await this.resolveTargetAgents(event, runningAgents);

    const createdAt = new Date().toISOString();
    const files: string[] = [];

    // A per-agent spool keeps consumption independent and removes cross-agent lock contention.
    for (const agent of targetAgents) {
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
        agentRole: agent.role,
        event,
        source: {
          command: `codefleet trigger ${event.type}`,
        },
      };
      await atomicWriteJson(queueFilePath, message);
      files.push(queueFilePath);
    }

    return {
      enqueuedAgentIds: targetAgents.map((agent) => agent.id),
      files,
    };
  }

  private async resolveTargetAgents(
    event: SystemEvent,
    runningAgents: AgentRuntimeCollection["agents"],
  ): Promise<AgentRuntimeCollection["agents"]> {
    const serializedRoleByEventType: Partial<
      Record<SystemEvent["type"], "Developer" | "Polisher" | "Reviewer" | "Gatekeeper">
    > = {
      "source-brief.update": "Gatekeeper",
      "backlog.epic.ready": "Developer",
      "backlog.epic.polish.ready": "Polisher",
      "backlog.epic.review.ready": "Reviewer",
      "acceptance-test.required": "Gatekeeper",
    };
    const targetRole = serializedRoleByEventType[event.type];
    if (!targetRole) {
      return runningAgents;
    }

    // Serialized role-scoped events (implementation/review/test execution) are
    // limited to one running agent to avoid duplicated concurrent handling.
    const target = runningAgents.find((agent) => agent.role === targetRole);
    if (!target) {
      return [];
    }
    if (await this.hasInFlightEvent(target.id, event.type)) {
      return [];
    }
    return [target];
  }

  private async hasInFlightEvent(agentId: string, eventType: SystemEvent["type"]): Promise<boolean> {
    const queueRoot = path.join(this.runtimeDir, EVENT_QUEUE_ROOT, agentId);
    const queueDirs = [path.join(queueRoot, "pending"), path.join(queueRoot, "processing")];

    for (const queueDir of queueDirs) {
      let files: string[] = [];
      try {
        files = (await fs.readdir(queueDir)).filter((entry) => entry.endsWith(".json"));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      for (const file of files) {
        try {
          const raw = await fs.readFile(path.join(queueDir, file), "utf8");
          const parsed = JSON.parse(raw) as unknown;
          const type = extractEventType(parsed);
          if (type === eventType) {
            return true;
          }
        } catch {
          // Ignore malformed files here. Worker-side validation routes those to failed.
        }
      }
    }
    return false;
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

function extractEventType(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const event = (raw as { event?: unknown }).event;
  if (!event || typeof event !== "object") {
    return null;
  }
  return typeof (event as { type?: unknown }).type === "string" ? ((event as { type: string }).type as string) : null;
}
