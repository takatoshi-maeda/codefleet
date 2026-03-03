import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRuntimeCollection } from "../agent-runtime-model.js";
import type { AgentRole } from "../roles-model.js";
import {
  FleetExecutionLog,
  type FleetExecutionQueryResult,
  type FleetExecutionRecord,
  type FleetExecutionStatus,
} from "./fleet-execution-log.js";

const DEFAULT_RUNTIME_DIR = path.join(".codefleet", "runtime");
const DEFAULT_LOG_DIR = path.join(".codefleet", "logs", "agents");
const DEFAULT_WATCH_POLL_MS = 1_000;

export interface FleetActivityAgent {
  agentId: string;
  status: string;
  busy: boolean;
  currentTask?: string;
}

export interface FleetActivityRoleSnapshot {
  role: AgentRole;
  totalAgents: number;
  runningAgents: number;
  busyAgents: number;
  idleAgents: number;
  failedAgents: number;
  inflightTasks: number;
  inflightTurns: number;
  agents: FleetActivityAgent[];
}

export interface FleetActivitySnapshot {
  updatedAt: string;
  roles: FleetActivityRoleSnapshot[];
}

export interface FleetActivityListInput {
  roles?: AgentRole[];
}

export interface FleetExecutionListInput {
  role?: AgentRole;
  roles?: AgentRole[];
  status?: FleetExecutionStatus;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface FleetWatchResult {
  startedAt: string;
  endedAt: string;
  eventCount: number;
  reason: "timeout" | "client_closed" | "server_shutdown";
}

export interface FleetActivityWatchEvent {
  type: "fleet.activity.snapshot" | "fleet.activity.changed" | "fleet.activity.heartbeat" | "fleet.activity.complete";
  payload: Record<string, unknown>;
}

export interface FleetActivityWatchInput extends FleetActivityListInput {
  includeAgents?: boolean;
  heartbeatSec: number;
  maxDurationSec: number;
  notificationToken?: string;
  onEvent?: (event: FleetActivityWatchEvent) => Promise<void>;
}

export interface FleetLogsTailInput {
  role?: AgentRole;
  agentId?: string;
  tailPerAgent: number;
  contains?: string;
}

export interface FleetLogsTailResult {
  role: AgentRole | null;
  agents: Array<{ agentId: string; role: AgentRole; lines: string[]; lineCount: number; truncated: boolean }>;
}

export interface FleetLogsWatchEvent {
  type: "fleet.logs.chunk" | "fleet.logs.heartbeat" | "fleet.logs.complete";
  payload: Record<string, unknown>;
}

export interface FleetLogsTailWatchInput extends FleetLogsTailInput {
  heartbeatSec: number;
  maxDurationSec: number;
  notificationToken?: string;
  onEvent?: (event: FleetLogsWatchEvent) => Promise<void>;
}

export class FleetObservabilityService {
  private readonly executionLog: FleetExecutionLog;

  constructor(
    private readonly runtimeDir: string = DEFAULT_RUNTIME_DIR,
    private readonly logDir: string = DEFAULT_LOG_DIR,
    executionLog?: FleetExecutionLog,
  ) {
    this.executionLog = executionLog ?? new FleetExecutionLog(path.join(runtimeDir, "fleet", "executions.jsonl"));
  }

  async listActivity(input: FleetActivityListInput = {}): Promise<FleetActivitySnapshot> {
    const runtime = await readRuntime(path.join(this.runtimeDir, "agents.json"));
    const runningExecutions = await this.executionLog.list({ status: "running", limit: 2000 });
    const selectedRoles = resolveRoles(input.roles);
    const runningExecutionByAgent = new Map<string, FleetExecutionRecord>();
    for (const record of runningExecutions.executions) {
      runningExecutionByAgent.set(record.agentId, record);
    }

    const roles: FleetActivityRoleSnapshot[] = [];
    for (const role of selectedRoles) {
      const roleAgents = runtime.agents
        .filter((agent) => agent.role === role)
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id));
      const queueCounts = await Promise.all(roleAgents.map((agent) => this.countInFlightQueue(agent.id)));

      const agents = roleAgents.map((agent, index) => {
        const inFlight = queueCounts[index];
        const runningExecution = runningExecutionByAgent.get(agent.id);
        const busy = inFlight.processing > 0 || Boolean(runningExecution);
        const currentTask = runningExecution ? formatTaskLabel(runningExecution) : undefined;
        return {
          agentId: agent.id,
          status: agent.status,
          busy,
          ...(currentTask ? { currentTask } : {}),
          pendingTasks: inFlight.pending,
          processingTasks: inFlight.processing,
        };
      });

      const runningAgents = agents.filter((agent) => agent.status === "running").length;
      const busyAgents = agents.filter((agent) => agent.busy).length;
      const failedAgents = agents.filter((agent) => agent.status === "failed").length;
      const inflightTasks = agents.reduce((sum, agent) => sum + agent.pendingTasks + agent.processingTasks, 0);
      const inflightTurns = agents.filter((agent) => agent.processingTasks > 0).length;
      const idleAgents = Math.max(runningAgents - busyAgents, 0);

      roles.push({
        role,
        totalAgents: agents.length,
        runningAgents,
        busyAgents,
        idleAgents,
        failedAgents,
        inflightTasks,
        inflightTurns,
        agents: agents.map((agent) => ({
          agentId: agent.agentId,
          status: agent.status,
          busy: agent.busy,
          ...(agent.currentTask ? { currentTask: agent.currentTask } : {}),
        })),
      });
    }

    return { updatedAt: new Date().toISOString(), roles };
  }

  async watchActivity(input: FleetActivityWatchInput): Promise<FleetWatchResult> {
    const startedAt = new Date().toISOString();
    let eventCount = 0;
    let previous = await this.listActivity(input);
    await emitEvent(input.onEvent, {
      type: "fleet.activity.snapshot",
      payload: withToken(
        {
          updatedAt: previous.updatedAt,
          roles: previous.roles,
        },
        input.notificationToken,
      ),
    });
    eventCount += 1;

    const timeoutAt = Date.now() + input.maxDurationSec * 1_000;
    let lastHeartbeatAt = Date.now();
    while (Date.now() < timeoutAt) {
      await sleep(DEFAULT_WATCH_POLL_MS);
      const next = await this.listActivity(input);
      const changes = detectActivityChanges(previous, next);
      for (const change of changes) {
        await emitEvent(input.onEvent, {
          type: "fleet.activity.changed",
          payload: withToken(change, input.notificationToken),
        });
        eventCount += 1;
      }
      previous = next;

      if (Date.now() - lastHeartbeatAt >= input.heartbeatSec * 1_000) {
        await emitEvent(input.onEvent, {
          type: "fleet.activity.heartbeat",
          payload: withToken({ updatedAt: new Date().toISOString() }, input.notificationToken),
        });
        eventCount += 1;
        lastHeartbeatAt = Date.now();
      }
    }

    const endedAt = new Date().toISOString();
    await emitEvent(input.onEvent, {
      type: "fleet.activity.complete",
      payload: withToken(
        {
          eventCount,
          reason: "timeout",
        },
        input.notificationToken,
      ),
    });
    eventCount += 1;
    return {
      startedAt,
      endedAt,
      eventCount,
      reason: "timeout",
    };
  }

  async listExecutions(input: FleetExecutionListInput): Promise<FleetExecutionQueryResult> {
    if (input.role) {
      return this.executionLog.list({
        role: input.role,
        status: input.status,
        from: input.from,
        to: input.to,
        limit: input.limit,
        cursor: input.cursor,
      });
    }

    const all = await this.executionLog.list({
      status: input.status,
      from: input.from,
      to: input.to,
      limit: 2000,
    });
    const selectedRoles = input.roles ? new Set(input.roles) : null;
    const filtered = all.executions
      .filter((execution) => (selectedRoles ? selectedRoles.has(execution.role) : true))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, clampListLimit(input.limit));
    return { executions: filtered };
  }

  async tailLogs(input: FleetLogsTailInput): Promise<FleetLogsTailResult> {
    const runtime = await readRuntime(path.join(this.runtimeDir, "agents.json"));
    const roleAgents = resolveTailTargetAgents(runtime, input);
    const contains = input.contains?.trim();

    const agents = await Promise.all(
      roleAgents.map(async (agent) => {
        const filePath = path.join(this.logDir, `${agent.id}.log`);
        const content = await safeRead(filePath);
        const sourceLines = content
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0);
        const filtered = contains ? sourceLines.filter((line) => line.includes(contains)) : sourceLines;
        const startIndex = Math.max(filtered.length - input.tailPerAgent, 0);
        const lines = filtered.slice(startIndex);
        return {
          agentId: agent.id,
          role: agent.role,
          lines,
          lineCount: filtered.length,
          truncated: filtered.length > lines.length,
        };
      }),
    );

    return { role: input.role ?? null, agents };
  }

  async watchLogsTail(input: FleetLogsTailWatchInput): Promise<FleetWatchResult> {
    const startedAt = new Date().toISOString();
    const runtime = await readRuntime(path.join(this.runtimeDir, "agents.json"));
    const targets = resolveTailTargetAgents(runtime, input);
    const contains = input.contains?.trim();
    const offsets = new Map<string, number>();
    let eventCount = 0;
    let totalLineCount = 0;

    for (const target of targets) {
      const sourceLines = await this.readAgentLogLines(target.id);
      offsets.set(target.id, sourceLines.length);
      const filtered = contains ? sourceLines.filter((line) => line.includes(contains)) : sourceLines;
      const lines = filtered.slice(Math.max(filtered.length - input.tailPerAgent, 0));
      if (lines.length > 0) {
        await emitEvent(input.onEvent, {
          type: "fleet.logs.chunk",
          payload: withToken(
            {
              role: input.role ?? null,
              agentId: target.id,
              lines,
            },
            input.notificationToken,
          ),
        });
        eventCount += 1;
        totalLineCount += lines.length;
      }
    }

    const timeoutAt = Date.now() + input.maxDurationSec * 1_000;
    let lastHeartbeatAt = Date.now();
    while (Date.now() < timeoutAt) {
      await sleep(DEFAULT_WATCH_POLL_MS);
      for (const target of targets) {
        const sourceLines = await this.readAgentLogLines(target.id);
        const previousOffset = offsets.get(target.id) ?? 0;
        const nextOffset = sourceLines.length < previousOffset ? 0 : previousOffset;
        const appended = sourceLines.slice(nextOffset);
        offsets.set(target.id, sourceLines.length);
        const filtered = contains ? appended.filter((line) => line.includes(contains)) : appended;
        if (filtered.length === 0) {
          continue;
        }
        await emitEvent(input.onEvent, {
          type: "fleet.logs.chunk",
          payload: withToken(
            {
              role: input.role ?? null,
              agentId: target.id,
              lines: filtered,
            },
            input.notificationToken,
          ),
        });
        eventCount += 1;
        totalLineCount += filtered.length;
      }

      if (Date.now() - lastHeartbeatAt >= input.heartbeatSec * 1_000) {
        await emitEvent(input.onEvent, {
          type: "fleet.logs.heartbeat",
          payload: withToken({ updatedAt: new Date().toISOString() }, input.notificationToken),
        });
        eventCount += 1;
        lastHeartbeatAt = Date.now();
      }
    }

    const endedAt = new Date().toISOString();
    await emitEvent(input.onEvent, {
      type: "fleet.logs.complete",
      payload: withToken(
        {
          role: input.role ?? null,
          agentCount: targets.length,
          lineCount: totalLineCount,
        },
        input.notificationToken,
      ),
    });
    eventCount += 1;

    return {
      startedAt,
      endedAt,
      eventCount,
      reason: "timeout",
    };
  }

  private async countInFlightQueue(agentId: string): Promise<{ pending: number; processing: number }> {
    const base = path.join(this.runtimeDir, "events", "agents", agentId);
    const [pending, processing] = await Promise.all([
      countJsonFiles(path.join(base, "pending")),
      countJsonFiles(path.join(base, "processing")),
    ]);
    return { pending, processing };
  }

  private async readAgentLogLines(agentId: string): Promise<string[]> {
    const filePath = path.join(this.logDir, `${agentId}.log`);
    const content = await safeRead(filePath);
    return content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  }
}

function detectActivityChanges(
  before: FleetActivitySnapshot,
  after: FleetActivitySnapshot,
): Array<Record<string, unknown>> {
  const beforeByRole = new Map(before.roles.map((role) => [role.role, role] as const));
  const changes: Array<Record<string, unknown>> = [];
  for (const roleSnapshot of after.roles) {
    const previousRole = beforeByRole.get(roleSnapshot.role);
    const previousAgents = new Map((previousRole?.agents ?? []).map((agent) => [agent.agentId, agent] as const));
    for (const agent of roleSnapshot.agents ?? []) {
      const beforeAgent = previousAgents.get(agent.agentId);
      if (!beforeAgent) {
        changes.push({
          updatedAt: after.updatedAt,
          role: roleSnapshot.role,
          agentId: agent.agentId,
          changeType: "agent_status_changed",
          before: null,
          after: agent,
        });
        continue;
      }
      if (beforeAgent.status !== agent.status) {
        changes.push({
          updatedAt: after.updatedAt,
          role: roleSnapshot.role,
          agentId: agent.agentId,
          changeType: "agent_status_changed",
          before: beforeAgent,
          after: agent,
        });
        continue;
      }
      if (!beforeAgent.busy && agent.busy) {
        changes.push({
          updatedAt: after.updatedAt,
          role: roleSnapshot.role,
          agentId: agent.agentId,
          changeType: "task_started",
          before: beforeAgent,
          after: agent,
        });
      } else if (beforeAgent.busy && !agent.busy) {
        changes.push({
          updatedAt: after.updatedAt,
          role: roleSnapshot.role,
          agentId: agent.agentId,
          changeType: "task_finished",
          before: beforeAgent,
          after: agent,
        });
      }
    }
  }
  return changes;
}

function withToken(payload: Record<string, unknown>, token: string | undefined): Record<string, unknown> {
  if (!token) {
    return payload;
  }
  return {
    ...payload,
    notificationToken: token,
  };
}

async function emitEvent<T extends { payload: Record<string, unknown> }>(
  emitter: ((event: T) => Promise<void>) | undefined,
  event: T,
): Promise<void> {
  if (!emitter) {
    return;
  }
  await emitter(event);
}

async function readRuntime(filePath: string): Promise<AgentRuntimeCollection> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AgentRuntimeCollection;
    return parsed;
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

async function safeRead(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function countJsonFiles(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter((entry) => entry.endsWith(".json")).length;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function resolveRoles(roles: AgentRole[] | undefined): AgentRole[] {
  const defaults: AgentRole[] = ["Orchestrator", "Gatekeeper", "Developer", "Polisher", "Reviewer"];
  if (!roles || roles.length === 0) {
    return defaults;
  }
  return [...new Set(roles)];
}

function resolveTailTargetAgents(
  runtime: AgentRuntimeCollection,
  input: { role?: AgentRole; agentId?: string },
): AgentRuntimeCollection["agents"] {
  return runtime.agents
    .filter((agent) => (input.role ? agent.role === input.role : true))
    .filter((agent) => (input.agentId ? agent.id === input.agentId : true))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
}

function formatTaskLabel(record: FleetExecutionRecord): string {
  if (record.epicId) {
    return `${record.eventType}:${record.epicId}`;
  }
  return record.eventType;
}

function clampListLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) {
    return 50;
  }
  return Math.min(value ?? 50, 200);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
