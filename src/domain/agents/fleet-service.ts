import { promises as fs } from "node:fs";
import path from "node:path";
import { AppServerClient } from "../../infra/appserver/app-server-client.js";
import { JsonRepository } from "../../infra/fs/json-repository.js";
import { FleetProcessManager } from "../../infra/process/fleet-process-manager.js";
import { BuildfleetError } from "../../shared/errors.js";
import type { AgentRuntime, AgentRuntimeCollection } from "../agent-runtime-model.js";
import type { AppServerSession, AppServerSessionCollection } from "../app-server-session-model.js";
import type { AgentRole, Roles } from "../roles-model.js";
import { SCHEMA_PATHS } from "../schema-paths.js";

const DEFAULT_ROLES_PATH = ".buildfleet/roles.json";
const DEFAULT_RUNTIME_DIR = ".buildfleet/runtime";
const DEFAULT_LOG_DIR = ".buildfleet/logs/agents";

export interface FleetStatus {
  summary: "running" | "stopped" | "degraded";
  agents: AgentRuntime[];
  sessions: AppServerSession[];
}

interface TargetInput {
  all?: boolean;
  role?: AgentRole;
}

export class FleetService {
  private readonly rolesRepository: JsonRepository<Roles>;
  private readonly runtimeRepository: JsonRepository<AgentRuntimeCollection>;
  private readonly sessionRepository: JsonRepository<AppServerSessionCollection>;

  constructor(
    private readonly rolesPath: string = DEFAULT_ROLES_PATH,
    private readonly runtimeDir: string = DEFAULT_RUNTIME_DIR,
    private readonly logDir: string = DEFAULT_LOG_DIR,
    private readonly processManager: FleetProcessManager = new FleetProcessManager(),
    private readonly appServerClient: AppServerClient = new AppServerClient(),
  ) {
    this.rolesRepository = new JsonRepository<Roles>(rolesPath, SCHEMA_PATHS.roles);
    this.runtimeRepository = new JsonRepository<AgentRuntimeCollection>(
      path.join(runtimeDir, "agents.json"),
      SCHEMA_PATHS.agentRuntime,
    );
    this.sessionRepository = new JsonRepository<AppServerSessionCollection>(
      path.join(runtimeDir, "app-server-sessions.json"),
      SCHEMA_PATHS.appServerSession,
    );
  }

  async status(role?: AgentRole): Promise<FleetStatus> {
    const selectedIds = new Set((await this.resolveTargetAgents({ all: !role, role })).map((agent) => agent.id));
    const runtimes = (await this.getOrInitializeRuntime()).agents.filter((agent) => selectedIds.has(agent.id));
    const sessions = (await this.getOrInitializeSessions()).sessions.filter((session) => selectedIds.has(session.agentId));

    const summary = summarizeStatus(runtimes, sessions);
    return { summary, agents: runtimes, sessions };
  }

  async up(input: { role?: AgentRole; detached?: boolean } = {}): Promise<FleetStatus> {
    const targets = await this.resolveTargetAgents({ all: !input.role, role: input.role });
    const runtime = await this.getOrInitializeRuntime();
    const sessions = await this.getOrInitializeSessions();
    const now = new Date().toISOString();

    for (const target of targets) {
      const runtimeAgent = upsertRuntime(runtime, {
        id: target.id,
        role: target.role,
        status: "starting",
        pid: null,
        cwd: process.cwd(),
        startedAt: now,
        lastHeartbeatAt: now,
      });

      upsertSession(sessions, {
        agentId: target.id,
        status: "initializing",
        initialized: false,
        lastNotificationAt: now,
      });

      try {
        const processStart = await this.processManager.start(target.id, process.cwd(), Boolean(input.detached));
        runtimeAgent.pid = processStart.pid;
        runtimeAgent.startedAt = processStart.startedAt;
        runtimeAgent.lastHeartbeatAt = processStart.startedAt;

        const handshake = await this.appServerClient.handshake(target.id);
        runtimeAgent.status = "running";
        runtimeAgent.lastHeartbeatAt = handshake.lastNotificationAt;
        runtimeAgent.lastError = undefined;

        const session = upsertSession(sessions, {
          agentId: target.id,
          status: "ready",
          initialized: true,
          threadId: handshake.threadId,
          activeTurnId: handshake.activeTurnId,
          lastNotificationAt: handshake.lastNotificationAt,
        });
        session.lastError = undefined;
      } catch (error) {
        runtimeAgent.status = "failed";
        runtimeAgent.lastError = error instanceof Error ? error.message : String(error);
        runtimeAgent.lastHeartbeatAt = new Date().toISOString();

        const session = upsertSession(sessions, {
          agentId: target.id,
          status: "error",
          initialized: false,
          lastNotificationAt: new Date().toISOString(),
        });
        session.lastError = runtimeAgent.lastError;
      }
    }

    runtime.updatedAt = new Date().toISOString();
    sessions.updatedAt = new Date().toISOString();
    await this.runtimeRepository.save(runtime);
    await this.sessionRepository.save(sessions);

    return this.status(input.role);
  }

  async down(input: TargetInput): Promise<FleetStatus> {
    const targets = await this.resolveTargetAgents(input);
    const runtime = await this.getOrInitializeRuntime();
    const sessions = await this.getOrInitializeSessions();
    const now = new Date().toISOString();

    for (const target of targets) {
      const runtimeAgent = upsertRuntime(runtime, {
        id: target.id,
        role: target.role,
        status: "stopped",
        pid: null,
        cwd: process.cwd(),
        startedAt: now,
        lastHeartbeatAt: now,
      });

      await this.processManager.stop(runtimeAgent.pid);
      runtimeAgent.status = "stopped";
      runtimeAgent.pid = null;
      runtimeAgent.lastHeartbeatAt = new Date().toISOString();

      upsertSession(sessions, {
        agentId: target.id,
        status: "disconnected",
        initialized: false,
        threadId: null,
        activeTurnId: null,
        lastNotificationAt: new Date().toISOString(),
      });
    }

    runtime.updatedAt = new Date().toISOString();
    sessions.updatedAt = new Date().toISOString();
    await this.runtimeRepository.save(runtime);
    await this.sessionRepository.save(sessions);

    return this.status(input.role);
  }

  async restart(input: { all?: boolean; role?: AgentRole; detached?: boolean }): Promise<FleetStatus> {
    await this.down({ all: input.all, role: input.role });
    return this.up({ role: input.role, detached: input.detached });
  }

  async logs(input: { all?: boolean; role?: AgentRole; tail?: number }): Promise<string> {
    const targets = await this.resolveTargetAgents({ all: input.all, role: input.role });
    const tail = input.tail ?? 200;

    const lines: string[] = [];
    for (const target of targets) {
      const file = path.join(this.logDir, `${target.id}.log`);
      const content = await safeRead(file);
      const outputLines = content.split(/\r?\n/).filter((line) => line.length > 0);
      const selected = outputLines.slice(Math.max(outputLines.length - tail, 0));
      lines.push(`[${target.id}]`);
      lines.push(...selected);
    }

    return lines.join("\n");
  }

  private async resolveTargetAgents(input: TargetInput): Promise<Roles["agents"]> {
    const roles = await this.getOrInitializeRoles();
    if (roles.agents.length === 0) {
      throw new BuildfleetError("ERR_NOT_FOUND", "no agents defined in roles.json");
    }

    if (input.role) {
      return roles.agents.filter((agent) => agent.role === input.role);
    }

    if (input.all || (!input.all && !input.role)) {
      return roles.agents;
    }

    throw new BuildfleetError("ERR_VALIDATION", "either --all or --role must be specified");
  }

  private async getOrInitializeRoles(): Promise<Roles> {
    try {
      return await this.rolesRepository.get();
    } catch (error) {
      if (error instanceof BuildfleetError && error.code === "ERR_NOT_FOUND") {
        const initial: Roles = { agents: [] };
        await this.rolesRepository.save(initial);
        return initial;
      }

      throw error;
    }
  }

  private async getOrInitializeRuntime(): Promise<AgentRuntimeCollection> {
    try {
      return await this.runtimeRepository.get();
    } catch (error) {
      if (error instanceof BuildfleetError && error.code === "ERR_NOT_FOUND") {
        await fs.mkdir(this.runtimeDir, { recursive: true });
        const now = new Date().toISOString();
        const initial: AgentRuntimeCollection = { version: 1, updatedAt: now, agents: [] };
        await this.runtimeRepository.save(initial);
        return initial;
      }

      throw error;
    }
  }

  private async getOrInitializeSessions(): Promise<AppServerSessionCollection> {
    try {
      return await this.sessionRepository.get();
    } catch (error) {
      if (error instanceof BuildfleetError && error.code === "ERR_NOT_FOUND") {
        await fs.mkdir(this.runtimeDir, { recursive: true });
        const now = new Date().toISOString();
        const initial: AppServerSessionCollection = { version: 1, updatedAt: now, sessions: [] };
        await this.sessionRepository.save(initial);
        return initial;
      }

      throw error;
    }
  }
}

function summarizeStatus(agents: AgentRuntime[], sessions: AppServerSession[]): "running" | "stopped" | "degraded" {
  if (agents.length === 0) {
    return "stopped";
  }

  const sessionByAgentId = new Map(sessions.map((session) => [session.agentId, session]));
  const allRunning = agents.every((agent) => {
    const session = sessionByAgentId.get(agent.id);
    return agent.status === "running" && session?.status === "ready";
  });

  if (allRunning) {
    return "running";
  }

  const allStopped = agents.every((agent) => agent.status === "stopped");
  if (allStopped) {
    return "stopped";
  }

  return "degraded";
}

function upsertRuntime(collection: AgentRuntimeCollection, input: AgentRuntime): AgentRuntime {
  const existing = collection.agents.find((agent) => agent.id === input.id);
  if (existing) {
    Object.assign(existing, input);
    return existing;
  }

  collection.agents.push(input);
  return input;
}

function upsertSession(collection: AppServerSessionCollection, input: AppServerSession): AppServerSession {
  const existing = collection.sessions.find((session) => session.agentId === input.agentId);
  if (existing) {
    Object.assign(existing, input);
    return existing;
  }

  collection.sessions.push(input);
  return input;
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
