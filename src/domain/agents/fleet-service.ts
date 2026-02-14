import { promises as fs } from "node:fs";
import path from "node:path";
import { AppServerClient } from "../../infra/appserver/app-server-client.js";
import { JsonRepository } from "../../infra/fs/json-repository.js";
import { FleetProcessManager } from "../../infra/process/fleet-process-manager.js";
import { CodefleetError } from "../../shared/errors.js";
import { SYSTEM_EVENT_TYPES, type SystemEvent } from "../../events/router.js";
import type { AgentRuntime, AgentRuntimeCollection } from "../agent-runtime-model.js";
import type { AppServerSession, AppServerSessionCollection } from "../app-server-session-model.js";
import type { AgentEventQueueMessage } from "../events/agent-event-queue-message-model.js";
import type { AgentRole } from "../roles-model.js";
import { SCHEMA_PATHS } from "../schema-paths.js";
import { getRoleEventPromptDefinition } from "./agent-role-definitions.js";
import { renderEventPromptTemplate } from "./event-prompt-template.js";
import { getRoleEventPromptTemplate, getRoleStartupPrompt } from "./role-prompts.js";

const DEFAULT_ROLES_PATH = ".codefleet/roles.json";
const DEFAULT_RUNTIME_DIR = ".codefleet/runtime";
const DEFAULT_LOG_DIR = ".codefleet/logs/agents";
const DEFAULT_GATEKEEPER_COUNT = 1;
const DEFAULT_DEVELOPER_COUNT = 1;
const DEFAULT_REVIEWER_COUNT = 1;
const FIXED_ORCHESTRATOR_COUNT = 1;

export interface FleetStatus {
  summary: "running" | "stopped" | "degraded";
  agents: AgentRuntime[];
  sessions: AppServerSession[];
}

interface TargetInput {
  all?: boolean;
  role?: AgentRole;
}

export interface DispatchAgentEventInput {
  agentId: string;
  agentRole: AgentRole;
  event: SystemEvent;
}

export class FleetService {
  private readonly runtimeRepository: JsonRepository<AgentRuntimeCollection>;
  private readonly sessionRepository: JsonRepository<AppServerSessionCollection>;
  private threadResponseLanguage?: string;

  constructor(
    private readonly rolesPath: string = DEFAULT_ROLES_PATH,
    private readonly runtimeDir: string = DEFAULT_RUNTIME_DIR,
    private readonly logDir: string = DEFAULT_LOG_DIR,
    private readonly processManager: FleetProcessManager = new FleetProcessManager(),
    private readonly appServerClient: AppServerClient = new AppServerClient(),
  ) {
    // Retained for compatibility with existing constructor call sites.
    void this.rolesPath;
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
    const runtimeCollection = await this.getOrInitializeRuntime();
    const sessionCollection = await this.getOrInitializeSessions();
    const runtimes = role
      ? runtimeCollection.agents.filter((agent) => agent.role === role)
      : runtimeCollection.agents;
    const selectedIds = new Set(runtimes.map((agent) => agent.id));
    const sessions = sessionCollection.sessions.filter((session) => selectedIds.has(session.agentId));

    const summary = summarizeStatus(runtimes, sessions);
    return { summary, agents: runtimes, sessions };
  }

  async up(input: {
    detached?: boolean;
    gatekeepers?: number;
    developers?: number;
    reviewers?: number;
    lang?: string;
  } = {}): Promise<FleetStatus> {
    this.threadResponseLanguage = normalizeLanguage(input.lang);
    const targets = buildTargetAgents({
      gatekeepers: input.gatekeepers ?? DEFAULT_GATEKEEPER_COUNT,
      developers: input.developers ?? DEFAULT_DEVELOPER_COUNT,
      reviewers: input.reviewers ?? DEFAULT_REVIEWER_COUNT,
    });
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
        const startupPrompt = await getRoleStartupPrompt(target.role);
        const processStart = await this.appServerClient.startAgent({
          agentId: target.id,
          role: target.role,
          prompt: startupPrompt,
          cwd: process.cwd(),
          detached: Boolean(input.detached),
        });
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

    return this.status();
  }

  async down(input: TargetInput): Promise<FleetStatus> {
    const runtime = await this.getOrInitializeRuntime();
    const targets = resolveRuntimeTargets(runtime.agents, input);
    const sessions = await this.getOrInitializeSessions();
    const now = new Date().toISOString();

    for (const target of targets) {
      // Capture the current PID before mutating persisted runtime state. The
      // shutdown signal must target the process that was previously started.
      const runningRuntime = runtime.agents.find((agent) => agent.id === target.id);
      const pidToStop = runningRuntime?.pid ?? null;

      const runtimeAgent = upsertRuntime(runtime, {
        id: target.id,
        role: target.role,
        status: "stopped",
        pid: pidToStop,
        cwd: runningRuntime?.cwd ?? process.cwd(),
        startedAt: runningRuntime?.startedAt ?? now,
        lastHeartbeatAt: now,
      });

      await this.processManager.stop(pidToStop);
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

  async restart(input: {
    detached?: boolean;
    gatekeepers?: number;
    developers?: number;
    reviewers?: number;
  }): Promise<FleetStatus> {
    await this.down({ all: true });
    return this.up(input);
  }

  async logs(input: { all?: boolean; role?: AgentRole; tail?: number }): Promise<string> {
    const runtime = await this.getOrInitializeRuntime();
    const targets = resolveRuntimeTargets(runtime.agents, { all: input.all, role: input.role });
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

  async dispatchQueuedEvent(message: AgentEventQueueMessage): Promise<SystemEvent | null> {
    return this.dispatchAgentEvent({
      agentId: message.agentId,
      agentRole: message.agentRole,
      event: message.event,
    });
  }

  async dispatchAgentEvent(input: DispatchAgentEventInput): Promise<SystemEvent | null> {
    const sessions = await this.getOrInitializeSessions();
    const session = upsertSession(sessions, {
      agentId: input.agentId,
      status: "ready",
      initialized: true,
      threadId: null,
      activeTurnId: null,
      lastNotificationAt: new Date().toISOString(),
    });

    const started = await this.appServerClient.startThread(input.agentId, {
      baseInstructions: buildThreadLanguageInstruction(this.threadResponseLanguage),
    });
    const threadId = started.threadId;
    const prompt = await this.buildEventPrompt(input.agentRole, input.event);
    const turn = await this.appServerClient.startTurn(input.agentId, {
      threadId,
      input: [{ type: "text", text: prompt }],
    });
    if (turn.turnId) {
      await this.appServerClient.waitForTurnCompletion(input.agentId, threadId, turn.turnId);
    }

    session.status = "ready";
    session.initialized = true;
    session.threadId = threadId;
    session.activeTurnId = turn.turnId;
    session.lastNotificationAt = turn.lastNotificationAt;
    session.lastError = undefined;
    sessions.updatedAt = new Date().toISOString();
    await this.sessionRepository.save(sessions);

    const eventPromptDefinition = getRoleEventPromptDefinition(input.agentRole, input.event.type);
    const emittedEventType = eventPromptDefinition.emitEventType;
    if (!emittedEventType) {
      return null;
    }
    // Re-emitting the same event type by default can create infinite self-trigger loops.
    if (emittedEventType === input.event.type) {
      return null;
    }
    if (!isSystemEventType(emittedEventType)) {
      return null;
    }
    return buildFollowUpEvent(emittedEventType, input.event);
  }

  private async getOrInitializeRuntime(): Promise<AgentRuntimeCollection> {
    try {
      return await this.runtimeRepository.get();
    } catch (error) {
      if (error instanceof CodefleetError && error.code === "ERR_NOT_FOUND") {
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
      if (error instanceof CodefleetError && error.code === "ERR_NOT_FOUND") {
        await fs.mkdir(this.runtimeDir, { recursive: true });
        const now = new Date().toISOString();
        const initial: AppServerSessionCollection = { version: 1, updatedAt: now, sessions: [] };
        await this.sessionRepository.save(initial);
        return initial;
      }

      throw error;
    }
  }

  private async buildEventPrompt(agentRole: AgentRole, event: SystemEvent): Promise<string> {
    const instructions = await getRoleStartupPrompt(agentRole);
    const eventPromptDefinition = getRoleEventPromptDefinition(agentRole, event.type);
    const eventPromptTemplate = await getRoleEventPromptTemplate(agentRole, eventPromptDefinition.promptEventType);
    if (!eventPromptTemplate && eventPromptDefinition.promptEventType !== eventPromptDefinition.triggerEventType) {
      throw new CodefleetError(
        "ERR_NOT_FOUND",
        `event prompt template not found for role=${agentRole} event=${eventPromptDefinition.promptEventType}`,
      );
    }
    if (!eventPromptTemplate) {
      return instructions.trim();
    }
    const eventParams = event as unknown as Record<string, unknown>;
    const promptContext = {
      ...eventParams,
      event: eventParams,
      triggerEventType: eventPromptDefinition.triggerEventType,
      promptEventType: eventPromptDefinition.promptEventType,
    };
    // Fail fast on missing template variables so misconfigured event prompts are
    // surfaced during queue handling instead of silently dropping dynamic context.
    const renderedEventPrompt = renderEventPromptTemplate(eventPromptTemplate, promptContext).trim();
    return `${instructions.trim()}\n\n${renderedEventPrompt}`;
  }
}

function buildThreadLanguageInstruction(lang: string | undefined): string | undefined {
  if (!lang) {
    return undefined;
  }
  // This instruction is injected at thread start so all replies in the thread consistently follow the requested language.
  return `All responses must be in ${lang}.`;
}

function normalizeLanguage(lang: string | undefined): string | undefined {
  if (typeof lang !== "string") {
    return undefined;
  }
  const trimmed = lang.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildFollowUpEvent(nextEventType: SystemEvent["type"], sourceEvent: SystemEvent): SystemEvent {
  if (nextEventType === "docs.update") {
    return {
      type: "docs.update",
      paths: sourceEvent.type === "docs.update" ? [...sourceEvent.paths] : [],
    };
  }
  if (nextEventType === "acceptance-test.update") {
    return { type: "acceptance-test.update" };
  }
  if (nextEventType === "backlog.update") {
    return { type: "backlog.update" };
  }
  if (nextEventType === "backlog.epic.review.ready") {
    const epicId = sourceEvent.type === "backlog.epic.ready" ? sourceEvent.epicId : undefined;
    if (!epicId) {
      throw new CodefleetError(
        "ERR_VALIDATION",
        "cannot emit backlog.epic.review.ready without epicId from source backlog.epic.ready event",
      );
    }
    return { type: "backlog.epic.review.ready", epicId };
  }
  return { type: "backlog.epic.ready" };
}

function isSystemEventType(value: string): value is SystemEvent["type"] {
  return SYSTEM_EVENT_TYPES.includes(value as SystemEvent["type"]);
}

interface TargetAgent {
  id: string;
  role: AgentRole;
}

interface RoleCountInput {
  gatekeepers: number;
  developers: number;
  reviewers: number;
}

function buildTargetAgents(counts: RoleCountInput): TargetAgent[] {
  validateRoleCount("gatekeepers", counts.gatekeepers);
  validateRoleCount("developers", counts.developers);
  validateRoleCount("reviewers", counts.reviewers);

  const targets = [
    ...buildAgentsByRole("Orchestrator", "orchestrator", FIXED_ORCHESTRATOR_COUNT),
    ...buildAgentsByRole("Gatekeeper", "gatekeeper", counts.gatekeepers),
    ...buildAgentsByRole("Developer", "developer", counts.developers),
    ...buildAgentsByRole("Reviewer", "reviewer", counts.reviewers),
  ];
  return targets;
}

function buildAgentsByRole(role: AgentRole, idPrefix: string, count: number): TargetAgent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${idPrefix}-${index + 1}`,
    role,
  }));
}

function resolveRuntimeTargets(runtimeAgents: AgentRuntime[], input: TargetInput): TargetAgent[] {
  if (input.role) {
    return runtimeAgents.filter((agent) => agent.role === input.role).map((agent) => ({ id: agent.id, role: agent.role }));
  }

  if (input.all || (!input.all && !input.role)) {
    return runtimeAgents.map((agent) => ({ id: agent.id, role: agent.role }));
  }

  throw new CodefleetError("ERR_VALIDATION", "either --all or --role must be specified");
}

function validateRoleCount(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new CodefleetError("ERR_VALIDATION", `${label} must be a non-negative integer`);
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
