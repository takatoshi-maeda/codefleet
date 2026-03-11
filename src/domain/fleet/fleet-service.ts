import { promises as fs } from "node:fs";
import path from "node:path";
import { AppServerClient } from "../../infra/appserver/app-server-client.js";
import { ClaudeAgentSdkRuntime } from "../../infra/agent-runtime/claude-agent-sdk-runtime.js";
import { CodexAppServerRuntime } from "../../infra/agent-runtime/codex-app-server-runtime.js";
import { JsonRepository } from "../../infra/fs/json-repository.js";
import { FleetProcessManager } from "../../infra/process/fleet-process-manager.js";
import { CodefleetError } from "../../shared/errors.js";
import { SYSTEM_EVENT_TYPES, type SystemEvent } from "../../events/router.js";
import type { AgentSession, AgentSessionCollection } from "../agent-session-model.js";
import type { AgentRuntime, AgentRuntimeCollection } from "../agent-runtime-model.js";
import type { AgentEventQueueMessage } from "../events/agent-event-queue-message-model.js";
import type { RoleHookPhase, RoleHooksByAgentRole } from "../hooks-model.js";
import type { AgentRole } from "../roles-model.js";
import { SCHEMA_PATHS } from "../schema-paths.js";
import { ShellHookCommandRunner, type HookCommandRunner } from "../../infra/process/hook-command-runner.js";
import { StaticAgentRuntimeResolver, type AgentRuntimeResolver } from "./agent-runtime-resolver.js";
import type { AgentProviderId, RoleAgentRuntime } from "./role-agent-runtime.js";
import type {
  FleetApiServerLifecycle,
  FleetApiServerStatus,
  FleetDiscoveredApiServer,
} from "./fleet-api-server-lifecycle-port.js";
import { getRoleEventPromptDefinition } from "./agent-role-definitions.js";
import { renderEventPromptTemplate } from "./event-prompt-template.js";
import { getRoleEventPromptTemplate, getRoleStartupPrompt } from "./role-prompts.js";

const DEFAULT_ROLES_PATH = ".codefleet/roles.json";
const DEFAULT_RUNTIME_DIR = ".codefleet/runtime";
const DEFAULT_LOG_DIR = ".codefleet/logs/agents";
const CONFIG_FILE_NAME = "config.json";
const DEFAULT_GATEKEEPER_COUNT = 1;
const DEFAULT_FRONTEND_DEVELOPER_COUNT = 1;
const DEFAULT_DEVELOPER_COUNT = 1;
const DEFAULT_DESIGNER_COUNT = 1;
const DEFAULT_REVIEWER_COUNT = 1;
const FIXED_ORCHESTRATOR_COUNT = 1;
const FIXED_CURATOR_COUNT = 1;
const LEGACY_APP_SERVER_SESSION_FILE = "app-server-sessions.json";
const SUPPORTED_AGENT_PROVIDERS = ["codex-app-server", "claude-agent-sdk"] as const;
const DEFAULT_CLAUDE_AGENT_SDK_PERMISSION_MODE = "bypassPermissions" as const;
const DEFAULT_CLAUDE_AGENT_SDK_AUTO_MEMORY_ENABLED = false;

interface ResolvedRoleRuntimeConfig {
  provider: AgentProviderId | "claude-agent-sdk";
  config: Record<string, unknown>;
}

const BUILTIN_ROLE_RUNTIME_DEFAULTS: Record<AgentRole, ResolvedRoleRuntimeConfig> = {
  Orchestrator: {
    provider: "claude-agent-sdk",
    config: {
      model: "claude-opus-4-6",
      permissionMode: DEFAULT_CLAUDE_AGENT_SDK_PERMISSION_MODE,
      settings: { autoMemoryEnabled: DEFAULT_CLAUDE_AGENT_SDK_AUTO_MEMORY_ENABLED },
    },
  },
  Curator: {
    provider: "claude-agent-sdk",
    config: {
      model: "claude-opus-4-6",
      permissionMode: DEFAULT_CLAUDE_AGENT_SDK_PERMISSION_MODE,
      settings: { autoMemoryEnabled: DEFAULT_CLAUDE_AGENT_SDK_AUTO_MEMORY_ENABLED },
    },
  },
  FrontendDeveloper: {
    provider: "claude-agent-sdk",
    config: {
      model: "claude-opus-4-6",
      permissionMode: DEFAULT_CLAUDE_AGENT_SDK_PERMISSION_MODE,
      settings: { autoMemoryEnabled: DEFAULT_CLAUDE_AGENT_SDK_AUTO_MEMORY_ENABLED },
    },
  },
  Developer: {
    provider: "codex-app-server",
    config: { model: "gpt-5.4" },
  },
  Polisher: {
    provider: "codex-app-server",
    config: { model: "gpt-5.4" },
  },
  Gatekeeper: {
    provider: "codex-app-server",
    config: { model: "gpt-5.4" },
  },
  Reviewer: {
    provider: "codex-app-server",
    config: { model: "gpt-5.4" },
  },
};

export interface FleetStatus {
  summary: "running" | "stopped" | "degraded";
  agents: AgentRuntime[];
  sessions: AgentSession[];
  apiServer?: FleetApiServerStatus;
  discoveredApiServers?: FleetDiscoveredApiServer[];
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
  private readonly sessionRepository: JsonRepository<AgentSessionCollection>;
  private threadResponseLanguage?: string;
  private reviewerPlaywrightServerUrl?: string;
  private runtimeConfigByRole = new Map<AgentRole, ResolvedRoleRuntimeConfig>();
  private readonly agentRuntimeResolver: AgentRuntimeResolver;

  constructor(
    private readonly rolesPath: string = DEFAULT_ROLES_PATH,
    private readonly runtimeDir: string = DEFAULT_RUNTIME_DIR,
    private readonly logDir: string = DEFAULT_LOG_DIR,
    private readonly processManager: FleetProcessManager = new FleetProcessManager(),
    private readonly appServerClient: AppServerClient = new AppServerClient(),
    private readonly hooksPath?: string,
    private readonly hookCommandRunner: HookCommandRunner = new ShellHookCommandRunner(),
    private readonly apiServerLifecycle?: FleetApiServerLifecycle,
    agentRuntimeResolver?: AgentRuntimeResolver | RoleAgentRuntime,
  ) {
    // Retained for compatibility with existing constructor call sites.
    void this.rolesPath;
    void this.hooksPath;
    this.agentRuntimeResolver = normalizeAgentRuntimeResolver(agentRuntimeResolver, this.appServerClient);
    this.runtimeRepository = new JsonRepository<AgentRuntimeCollection>(
      path.join(runtimeDir, "agents.json"),
      SCHEMA_PATHS.agentRuntime,
    );
    this.sessionRepository = new JsonRepository<AgentSessionCollection>(
      path.join(runtimeDir, "agent-sessions.json"),
      SCHEMA_PATHS.agentSession,
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

    const apiServer = this.apiServerLifecycle?.status();
    const discoveredApiServers = this.apiServerLifecycle ? await this.apiServerLifecycle.discover() : undefined;
    const summary = summarizeStatus(runtimes, sessions, apiServer);
    return {
      summary,
      agents: runtimes,
      sessions,
      ...(apiServer ? { apiServer } : {}),
      ...(discoveredApiServers ? { discoveredApiServers } : {}),
    };
  }

  async up(input: {
    detached?: boolean;
    gatekeepers?: number;
    frontendDevelopers?: number;
    developers?: number;
    polishers?: number;
    reviewers?: number;
    lang?: string;
    playwrightServerUrl?: string;
  } = {}): Promise<FleetStatus> {
    const config = await this.readConfigFile();
    this.threadResponseLanguage = this.resolveThreadResponseLanguage(input.lang, config);
    this.reviewerPlaywrightServerUrl = normalizePlaywrightServerUrl(input.playwrightServerUrl);
    this.runtimeConfigByRole = buildResolvedRuntimeConfigByRole(config);
    if (this.apiServerLifecycle) {
      try {
        await this.apiServerLifecycle.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CodefleetError("ERR_UNEXPECTED", `failed to start fleet API server: ${message}`, error);
      }
    }

    const targets = buildTargetAgents({
      gatekeepers: input.gatekeepers ?? DEFAULT_GATEKEEPER_COUNT,
      frontendDevelopers: input.frontendDevelopers ?? DEFAULT_FRONTEND_DEVELOPER_COUNT,
      developers: input.developers ?? DEFAULT_DEVELOPER_COUNT,
      polishers: input.polishers ?? DEFAULT_DESIGNER_COUNT,
      reviewers: input.reviewers ?? DEFAULT_REVIEWER_COUNT,
    });
    const runtime = await this.getOrInitializeRuntime();
    const sessions = await this.getOrInitializeSessions();
    const now = new Date().toISOString();

    for (const target of targets) {
      const roleRuntime = this.requireConfiguredRuntime(target.role);
      const agentRuntime = this.agentRuntimeResolver.resolve(roleRuntime.provider);
      const runtimeAgent = upsertRuntime(runtime, {
        id: target.id,
        role: target.role,
        provider: roleRuntime.provider,
        runtimeOptions: cloneRuntimeOptions(roleRuntime.config),
        status: "starting",
        pid: null,
        cwd: process.cwd(),
        startedAt: now,
        lastHeartbeatAt: now,
      });

      upsertSession(sessions, {
        agentId: target.id,
        provider: roleRuntime.provider,
        status: "initializing",
        initialized: false,
        lastActivityAt: now,
      });

      try {
        const startupPrompt = await getRoleStartupPrompt(target.role);
        const prepared = await agentRuntime.prepareAgent({
          agentId: target.id,
          role: target.role,
          cwd: process.cwd(),
          detached: Boolean(input.detached),
          startupPrompt,
          playwrightServerUrl: target.role === "Reviewer" ? this.reviewerPlaywrightServerUrl : undefined,
          runtimeConfig: roleRuntime.config,
        });
        runtimeAgent.provider = prepared.provider;
        runtimeAgent.pid = prepared.pid;
        runtimeAgent.startedAt = prepared.startedAt;
        runtimeAgent.status = "running";
        runtimeAgent.lastHeartbeatAt = prepared.session.lastActivityAt;
        runtimeAgent.lastError = undefined;

        const session = upsertSession(sessions, {
          agentId: target.id,
          provider: prepared.provider,
          status: "ready",
          initialized: true,
          conversationId: prepared.session.conversationId,
          activeInvocationId: prepared.session.activeInvocationId,
          lastActivityAt: prepared.session.lastActivityAt,
        });
        session.lastError = undefined;
      } catch (error) {
        runtimeAgent.status = "failed";
        runtimeAgent.lastError = error instanceof Error ? error.message : String(error);
        runtimeAgent.lastHeartbeatAt = new Date().toISOString();

        const session = upsertSession(sessions, {
          agentId: target.id,
          provider: roleRuntime.provider,
          status: "error",
          initialized: false,
          lastActivityAt: new Date().toISOString(),
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
      const roleRuntime = this.requireConfiguredRuntime(target.role);
      const agentRuntime = this.agentRuntimeResolver.resolve(roleRuntime.provider);

      const runtimeAgent = upsertRuntime(runtime, {
        id: target.id,
        role: target.role,
        provider: runningRuntime?.provider ?? roleRuntime.provider,
        runtimeOptions: runningRuntime?.runtimeOptions ?? cloneRuntimeOptions(roleRuntime.config),
        status: "stopped",
        pid: pidToStop,
        cwd: runningRuntime?.cwd ?? process.cwd(),
        startedAt: runningRuntime?.startedAt ?? now,
        lastHeartbeatAt: now,
      });

      // Runtime shutdown releases provider-specific resources before the
      // process manager attempts to stop any local child process.
      await agentRuntime.shutdownAgent(target.id);
      await this.processManager.stop(pidToStop);
      runtimeAgent.status = "stopped";
      runtimeAgent.pid = null;
      runtimeAgent.lastHeartbeatAt = new Date().toISOString();

      upsertSession(sessions, {
        agentId: target.id,
        provider: runningRuntime?.provider ?? roleRuntime.provider,
        status: "disconnected",
        initialized: false,
        conversationId: null,
        activeInvocationId: null,
        lastActivityAt: new Date().toISOString(),
      });
    }

    runtime.updatedAt = new Date().toISOString();
    sessions.updatedAt = new Date().toISOString();
    await this.runtimeRepository.save(runtime);
    await this.sessionRepository.save(sessions);

    if (input.all && this.apiServerLifecycle) {
      await this.apiServerLifecycle.stop();
    }

    return this.status(input.role);
  }

  async restart(input: {
    detached?: boolean;
    gatekeepers?: number;
    frontendDevelopers?: number;
    developers?: number;
    polishers?: number;
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
    const hookContext = {
      agentId: input.agentId,
      role: input.agentRole,
      eventType: input.event.type,
    };
    try {
      await this.executeRoleHooks(input.agentRole, "before_start", hookContext);

      const sessions = await this.getOrInitializeSessions();
      const roleRuntime = this.requireConfiguredRuntime(input.agentRole);
      const agentRuntime = this.agentRuntimeResolver.resolve(roleRuntime.provider);
      const session = upsertSession(sessions, {
        agentId: input.agentId,
        provider: roleRuntime.provider,
        status: "ready",
        initialized: true,
        conversationId: null,
        activeInvocationId: null,
        lastActivityAt: new Date().toISOString(),
      });

      const prompt = await this.buildEventPrompt(input.agentRole, input.event);
      const execution = await agentRuntime.execute({
        agentId: input.agentId,
        role: input.agentRole,
        cwd: process.cwd(),
        prompt,
        responseLanguage: this.threadResponseLanguage,
        currentSession: session.initialized
          ? {
              conversationId: session.conversationId ?? null,
              activeInvocationId: session.activeInvocationId ?? null,
              lastActivityAt: session.lastActivityAt,
            }
          : undefined,
        runtimeConfig: roleRuntime.config,
      });

      session.provider = execution.provider;
      session.status = "ready";
      session.initialized = true;
      session.conversationId = execution.session.conversationId;
      session.activeInvocationId = execution.session.activeInvocationId;
      session.lastActivityAt = execution.session.lastActivityAt;
      session.lastError = undefined;
      sessions.updatedAt = new Date().toISOString();
      await this.sessionRepository.save(sessions);

      await this.executeRoleHooks(input.agentRole, "after_complete", hookContext);

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
    } catch (error) {
      await this.executeAfterFailHooks(input.agentRole, hookContext, error);
      throw error;
    }
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
      if (error instanceof CodefleetError && error.code === "ERR_VALIDATION") {
        const migrated = await this.tryMigrateLegacyRuntimeCollection();
        if (migrated) {
          return migrated;
        }
      }

      throw error;
    }
  }

  private async getOrInitializeSessions(): Promise<AgentSessionCollection> {
    try {
      return await this.sessionRepository.get();
    } catch (error) {
      if (error instanceof CodefleetError && error.code === "ERR_NOT_FOUND") {
        const migrated = await this.tryMigrateLegacySessionCollection();
        if (migrated) {
          return migrated;
        }
        await fs.mkdir(this.runtimeDir, { recursive: true });
        const now = new Date().toISOString();
        const initial: AgentSessionCollection = { version: 1, updatedAt: now, sessions: [] };
        await this.sessionRepository.save(initial);
        return initial;
      }

      throw error;
    }
  }

  private requireConfiguredRuntime(role: AgentRole): ResolvedRoleRuntimeConfig {
    return this.runtimeConfigByRole.get(role) ?? resolveRoleRuntimeConfig(null, role);
  }

  private async tryMigrateLegacyRuntimeCollection(): Promise<AgentRuntimeCollection | null> {
    const filePath = path.join(this.runtimeDir, "agents.json");
    const raw = await safeRead(filePath);
    if (!raw.trim()) {
      return null;
    }
    const parsed = parseJsonObject(raw, filePath);
    const candidate = parsed.agents;
    if (!Array.isArray(candidate)) {
      return null;
    }

    const migrated: AgentRuntimeCollection = {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      agents: candidate.map((entry) => migrateLegacyRuntimeAgent(entry)),
    };
    await this.runtimeRepository.save(migrated);
    return migrated;
  }

  private async tryMigrateLegacySessionCollection(): Promise<AgentSessionCollection | null> {
    const legacyPath = path.join(this.runtimeDir, LEGACY_APP_SERVER_SESSION_FILE);
    const raw = await safeRead(legacyPath);
    if (!raw.trim()) {
      return null;
    }
    const parsed = parseJsonObject(raw, legacyPath);
    const candidate = parsed.sessions;
    if (!Array.isArray(candidate)) {
      return null;
    }

    const migrated: AgentSessionCollection = {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      sessions: candidate.map((entry) => migrateLegacySession(entry)),
    };
    await this.sessionRepository.save(migrated);
    return migrated;
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
    if (agentRole === "Reviewer" && this.reviewerPlaywrightServerUrl) {
      const reviewerPlaywrightInstruction =
        `Playwright remote server endpoint: ${this.reviewerPlaywrightServerUrl}\n` +
        "Use this endpoint for all browser-based verification in this review.";
      return `${instructions.trim()}\n\n${reviewerPlaywrightInstruction}\n\n${renderedEventPrompt}`;
    }
    return `${instructions.trim()}\n\n${renderedEventPrompt}`;
  }

  private async executeAfterFailHooks(
    role: AgentRole,
    context: { agentId: string; role: AgentRole; eventType: SystemEvent["type"] },
    cause: unknown,
  ): Promise<void> {
    try {
      await this.executeRoleHooks(role, "after_fail", context);
    } catch (hookError) {
      const message = [
        `dispatch failed for role=${role} event=${context.eventType}`,
        `original error: ${toErrorMessage(cause)}`,
        `after_fail hook error: ${toErrorMessage(hookError)}`,
      ].join("; ");
      throw new CodefleetError("ERR_UNEXPECTED", message, hookError);
    }
  }

  private async executeRoleHooks(
    role: AgentRole,
    phase: RoleHookPhase,
    context: { agentId: string; role: AgentRole; eventType: SystemEvent["type"] },
  ): Promise<void> {
    const hooksByRole = await this.readHooksByRole();
    const roleHooks = hooksByRole[role];
    if (!roleHooks) {
      return;
    }
    const commands = normalizeHookCommands(roleHooks[phase]);
    for (const command of commands) {
      console.log(`[codefleet:hook] role=${role} phase=${phase} command=${command}`);
      // Expose hook context via env vars so scripts can stay generic across roles and phases.
      await this.hookCommandRunner.run(command, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEFLEET_HOOK_AGENT_ID: context.agentId,
          CODEFLEET_HOOK_ROLE: context.role,
          CODEFLEET_HOOK_EVENT_TYPE: context.eventType,
          CODEFLEET_HOOK_PHASE: phase,
        },
      });
    }
  }

  private async readHooksByRole(): Promise<RoleHooksByAgentRole> {
    const config = await this.readConfigFile();
    if (!config || !("hooks" in config) || config.hooks === undefined) {
      return {};
    }
    return parseRoleHooksByAgentRole(config.hooks);
  }

  private resolveThreadResponseLanguage(
    explicitLang: string | undefined,
    config: Record<string, unknown> | null,
  ): string | undefined {
    const normalizedExplicit = normalizeLanguage(explicitLang);
    if (normalizedExplicit) {
      return normalizedExplicit;
    }
    if (!config) {
      return undefined;
    }
    const configLang = config.lang;
    return typeof configLang === "string" ? normalizeLanguage(configLang) : undefined;
  }

  private async readConfigFile(): Promise<Record<string, unknown> | null> {
    const configPath = this.resolveConfigPath();
    const raw = await safeRead(configPath);
    if (raw.trim().length === 0) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        throw new CodefleetError("ERR_VALIDATION", `file is not a JSON object: ${configPath}`);
      }
      return parsed;
    } catch (error) {
      if (error instanceof CodefleetError) {
        throw error;
      }
      throw new CodefleetError("ERR_VALIDATION", `file is not valid JSON: ${configPath}`, error);
    }
  }

  private resolveConfigPath(): string {
    // Keep config colocated with roles/hooks so FleetService can be pointed at
    // a temporary workspace in tests without changing process.cwd().
    return path.join(path.dirname(this.rolesPath), CONFIG_FILE_NAME);
  }
}

function parseRoleHooksByAgentRole(value: unknown): RoleHooksByAgentRole {
  if (!isRecord(value)) {
    throw new CodefleetError("ERR_VALIDATION", "config.hooks must be a JSON object");
  }
  const candidate = isRecord(value.roles) ? value.roles : value;
  const parsed: RoleHooksByAgentRole = {};

  for (const role of ["Orchestrator", "Curator", "FrontendDeveloper", "Developer", "Polisher", "Gatekeeper", "Reviewer"] as const) {
    const roleValue = candidate[role];
    if (roleValue === undefined) {
      continue;
    }
    if (!isRecord(roleValue)) {
      throw new CodefleetError("ERR_VALIDATION", `hooks.${role} must be an object`);
    }
    parsed[role] = {
      before_start: parseHookCommandValue(role, "before_start", roleValue.before_start),
      after_complete: parseHookCommandValue(role, "after_complete", roleValue.after_complete),
      after_fail: parseHookCommandValue(role, "after_fail", roleValue.after_fail),
    };
  }
  return parsed;
}

function parseHookCommandValue(
  role: AgentRole,
  phase: RoleHookPhase,
  value: unknown,
): string | string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new CodefleetError("ERR_VALIDATION", `hooks.${role}.${phase} must be a string or string[]`);
  }
  return value;
}

function normalizeHookCommands(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).map((command) => command.trim()).filter((command) => command.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLanguage(lang: string | undefined): string | undefined {
  if (typeof lang !== "string") {
    return undefined;
  }
  const trimmed = lang.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlaywrightServerUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildFollowUpEvent(nextEventType: SystemEvent["type"], sourceEvent: SystemEvent): SystemEvent {
  if (nextEventType === "release-plan.create") {
    const releasePlanPath = sourceEvent.type === "release-plan.create" ? sourceEvent.path : undefined;
    if (!releasePlanPath) {
      throw new CodefleetError(
        "ERR_VALIDATION",
        "cannot emit release-plan.create without path from source release-plan.create event",
      );
    }
    return { type: "release-plan.create", path: releasePlanPath };
  }
  if (nextEventType === "source-brief.update") {
    const sourcePaths =
      sourceEvent.type === "release-plan.create"
        ? [sourceEvent.path]
        : sourceEvent.type === "source-brief.update"
          ? [...sourceEvent.sourcePaths]
          : [];
    return {
      type: "source-brief.update",
      briefPath: ".codefleet/data/source-brief/latest.md",
      sourcePaths,
    };
  }
  if (nextEventType === "acceptance-test.update") {
    return { type: "acceptance-test.update" };
  }
  if (nextEventType === "feedback-note.create") {
    const feedbackNotePath = sourceEvent.type === "feedback-note.create" ? sourceEvent.path : undefined;
    if (!feedbackNotePath) {
      throw new CodefleetError(
        "ERR_VALIDATION",
        "cannot emit feedback-note.create without path from source feedback-note.create event",
      );
    }
    return { type: "feedback-note.create", path: feedbackNotePath };
  }
  if (nextEventType === "acceptance-test.required") {
    return { type: "acceptance-test.required" };
  }
  if (nextEventType === "backlog.update") {
    return { type: "backlog.update" };
  }
  if (nextEventType === "backlog.epic.review.ready") {
    const epicId =
      sourceEvent.type === "backlog.epic.ready" ||
      sourceEvent.type === "backlog.epic.frontend.ready" ||
      sourceEvent.type === "backlog.epic.frontend.completed" ||
      sourceEvent.type === "backlog.epic.polish.ready"
        ? sourceEvent.epicId
        : undefined;
    if (!epicId) {
      throw new CodefleetError(
        "ERR_VALIDATION",
        "cannot emit backlog.epic.review.ready without epicId from source backlog.epic.ready/backlog.epic.polish.ready event",
      );
    }
    return { type: "backlog.epic.review.ready", epicId };
  }
  if (nextEventType === "backlog.epic.frontend.completed") {
    const epicId = sourceEvent.type === "backlog.epic.frontend.ready" ? sourceEvent.epicId : undefined;
    if (!epicId) {
      throw new CodefleetError(
        "ERR_VALIDATION",
        "cannot emit backlog.epic.frontend.completed without epicId from source backlog.epic.frontend.ready event",
      );
    }
    return { type: "backlog.epic.frontend.completed", epicId };
  }
  if (nextEventType === "backlog.epic.polish.ready") {
    const epicId =
      sourceEvent.type === "backlog.epic.ready" || sourceEvent.type === "backlog.epic.frontend.completed"
        ? sourceEvent.epicId
        : undefined;
    if (!epicId) {
      throw new CodefleetError(
        "ERR_VALIDATION",
        "cannot emit backlog.epic.polish.ready without epicId from source backlog.epic.ready/backlog.epic.frontend.completed event",
      );
    }
    return { type: "backlog.epic.polish.ready", epicId };
  }
  if (nextEventType === "debug.playwright-test") {
    return { type: "debug.playwright-test" };
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
  frontendDevelopers: number;
  developers: number;
  polishers: number;
  reviewers: number;
}

function buildTargetAgents(counts: RoleCountInput): TargetAgent[] {
  validateRoleCount("gatekeepers", counts.gatekeepers);
  validateRoleCount("frontendDevelopers", counts.frontendDevelopers);
  validateRoleCount("developers", counts.developers);
  validateRoleCount("polishers", counts.polishers);
  validateRoleCount("reviewers", counts.reviewers);

  const targets = [
    ...buildAgentsByRole("Orchestrator", "orchestrator", FIXED_ORCHESTRATOR_COUNT),
    ...buildAgentsByRole("Curator", "curator", FIXED_CURATOR_COUNT),
    ...buildAgentsByRole("Gatekeeper", "gatekeeper", counts.gatekeepers),
    ...buildAgentsByRole("FrontendDeveloper", "frontend-developer", counts.frontendDevelopers),
    ...buildAgentsByRole("Developer", "developer", counts.developers),
    ...buildAgentsByRole("Polisher", "polisher", counts.polishers),
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

function summarizeStatus(
  agents: AgentRuntime[],
  sessions: AgentSession[],
  apiServer?: FleetApiServerStatus,
): "running" | "stopped" | "degraded" {
  if (agents.length === 0) {
    return "stopped";
  }

  const sessionByAgentId = new Map(sessions.map((session) => [session.agentId, session]));
  const allRunning = agents.every((agent) => {
    const session = sessionByAgentId.get(agent.id);
    return agent.status === "running" && session?.status === "ready";
  });

  const apiRunning = !apiServer || apiServer.state === "running";
  if (allRunning && apiRunning) {
    return "running";
  }

  const allStopped = agents.every((agent) => agent.status === "stopped");
  if (allStopped) {
    if (apiServer?.state === "running") {
      return "degraded";
    }
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

function upsertSession(collection: AgentSessionCollection, input: AgentSession): AgentSession {
  const existing = collection.sessions.find((session) => session.agentId === input.agentId);
  if (existing) {
    Object.assign(existing, input);
    return existing;
  }

  collection.sessions.push(input);
  return input;
}

function normalizeAgentRuntimeResolver(
  input: AgentRuntimeResolver | RoleAgentRuntime | undefined,
  appServerClient: AppServerClient,
): AgentRuntimeResolver {
  if (!input) {
    return new StaticAgentRuntimeResolver(
      new Map<AgentProviderId, RoleAgentRuntime>([
        ["codex-app-server", new CodexAppServerRuntime(appServerClient)],
        ["claude-agent-sdk", new ClaudeAgentSdkRuntime()],
      ]),
    );
  }
  if (isAgentRuntimeResolver(input)) {
    return input;
  }
  return new StaticAgentRuntimeResolver(new Map<AgentProviderId, RoleAgentRuntime>([[input.provider, input]]));
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

function buildResolvedRuntimeConfigByRole(config: Record<string, unknown> | null): Map<AgentRole, ResolvedRoleRuntimeConfig> {
  return new Map(
    (["Orchestrator", "Curator", "FrontendDeveloper", "Developer", "Polisher", "Gatekeeper", "Reviewer"] as const).map((role) => [
      role,
      resolveRoleRuntimeConfig(config, role),
    ]),
  );
}

function resolveRoleRuntimeConfig(
  config: Record<string, unknown> | null,
  role: AgentRole,
): ResolvedRoleRuntimeConfig {
  const agentRuntime = isRecord(config?.agentRuntime) ? config.agentRuntime : null;
  const rolesConfig = isRecord(agentRuntime?.roles) ? agentRuntime.roles : null;
  const roleConfig = rolesConfig && isRecord(rolesConfig[role]) ? rolesConfig[role] : null;
  if (roleConfig) {
    return parseConfiguredRuntime(roleConfig, `config.agentRuntime.roles.${role}`);
  }

  const defaultConfig = agentRuntime && isRecord(agentRuntime.default) ? agentRuntime.default : null;
  if (defaultConfig) {
    return parseConfiguredRuntime(defaultConfig, "config.agentRuntime.default");
  }

  // Built-in role defaults keep runtime selection deterministic even when no
  // repository config exists yet.
  return cloneResolvedRoleRuntimeConfig(BUILTIN_ROLE_RUNTIME_DEFAULTS[role]);
}

function parseConfiguredRuntime(value: Record<string, unknown>, label: string): ResolvedRoleRuntimeConfig {
  const provider = value.provider;
  if (!isSupportedAgentProvider(provider)) {
    throw new CodefleetError(
      "ERR_VALIDATION",
      `${label}.provider must be one of ${SUPPORTED_AGENT_PROVIDERS.join(", ")}`,
    );
  }
  const runtimeConfig = value.config;
  if (runtimeConfig !== undefined && !isRecord(runtimeConfig)) {
    throw new CodefleetError("ERR_VALIDATION", `${label}.config must be a JSON object`);
  }
  return {
    provider,
    // Mirror Claude runtime execution defaults in persisted fleet config so
    // status/log output describes the behavior that will actually occur.
    config: applyProviderRuntimeDefaults(provider, runtimeConfig ?? {}),
  };
}

function applyProviderRuntimeDefaults(
  provider: AgentProviderId | "claude-agent-sdk",
  runtimeConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (provider !== "claude-agent-sdk") {
    return runtimeConfig;
  }
  const settings = isRecord(runtimeConfig.settings) ? runtimeConfig.settings : {};
  return {
    ...runtimeConfig,
    permissionMode:
      "permissionMode" in runtimeConfig ? runtimeConfig.permissionMode : DEFAULT_CLAUDE_AGENT_SDK_PERMISSION_MODE,
    settings: {
      ...settings,
      autoMemoryEnabled:
        typeof settings.autoMemoryEnabled === "boolean"
          ? settings.autoMemoryEnabled
          : DEFAULT_CLAUDE_AGENT_SDK_AUTO_MEMORY_ENABLED,
    },
  };
}

function isSupportedAgentProvider(value: unknown): value is AgentProviderId {
  return typeof value === "string" && SUPPORTED_AGENT_PROVIDERS.includes(value as (typeof SUPPORTED_AGENT_PROVIDERS)[number]);
}

function isAgentRuntimeResolver(value: AgentRuntimeResolver | RoleAgentRuntime): value is AgentRuntimeResolver {
  return "resolve" in value && typeof value.resolve === "function";
}

function parseJsonObject(raw: string, filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new CodefleetError("ERR_VALIDATION", `file is not a JSON object: ${filePath}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof CodefleetError) {
      throw error;
    }
    throw new CodefleetError("ERR_VALIDATION", `file is not valid JSON: ${filePath}`, error);
  }
}

function migrateLegacyRuntimeAgent(entry: unknown): AgentRuntime {
  if (!isRecord(entry)) {
    throw new CodefleetError("ERR_VALIDATION", "legacy runtime agent entry must be an object");
  }
  const runtime = entry as Partial<AgentRuntime> & { provider?: unknown };
  return {
    id: expectNonEmptyString(runtime.id, "legacy runtime agent.id"),
    role: expectAgentRole(runtime.role, "legacy runtime agent.role"),
    provider: isSupportedAgentProvider(runtime.provider) ? runtime.provider : "codex-app-server",
    ...(isRecord(runtime.runtimeOptions) ? { runtimeOptions: runtime.runtimeOptions } : {}),
    status: expectRuntimeStatus(runtime.status, "legacy runtime agent.status"),
    pid: typeof runtime.pid === "number" || runtime.pid === null ? runtime.pid : null,
    cwd: expectNonEmptyString(runtime.cwd, "legacy runtime agent.cwd"),
    startedAt: expectNonEmptyString(runtime.startedAt, "legacy runtime agent.startedAt"),
    lastHeartbeatAt: expectNonEmptyString(runtime.lastHeartbeatAt, "legacy runtime agent.lastHeartbeatAt"),
    ...(typeof runtime.lastError === "string" && runtime.lastError.length > 0 ? { lastError: runtime.lastError } : {}),
  };
}

function migrateLegacySession(entry: unknown): AgentSession {
  if (!isRecord(entry)) {
    throw new CodefleetError("ERR_VALIDATION", "legacy runtime session entry must be an object");
  }
  const session = entry as Record<string, unknown>;
  return {
    agentId: expectNonEmptyString(session.agentId, "legacy runtime session.agentId"),
    provider: isSupportedAgentProvider(session.provider) ? session.provider : "codex-app-server",
    status: expectSessionStatus(session.status, "legacy runtime session.status"),
    initialized: typeof session.initialized === "boolean" ? session.initialized : false,
    conversationId: readNullableString(session.conversationId) ?? readNullableString(session.threadId),
    activeInvocationId: readNullableString(session.activeInvocationId) ?? readNullableString(session.activeTurnId),
    lastActivityAt:
      readRequiredString(session.lastActivityAt, "legacy runtime session.lastActivityAt") ??
      expectNonEmptyString(session.lastNotificationAt, "legacy runtime session.lastNotificationAt"),
    ...(typeof session.lastError === "string" && session.lastError.length > 0 ? { lastError: session.lastError } : {}),
  };
}

function readRequiredString(value: unknown, _label: string): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cloneRuntimeOptions(runtimeOptions: Record<string, unknown>): Record<string, unknown> {
  // Persist the exact startup/runtime choice used for this agent so later
  // config edits do not obscure which provider/options the logs refer to.
  return JSON.parse(JSON.stringify(runtimeOptions)) as Record<string, unknown>;
}

function cloneResolvedRoleRuntimeConfig(runtime: ResolvedRoleRuntimeConfig): ResolvedRoleRuntimeConfig {
  return {
    provider: runtime.provider,
    config: cloneRuntimeOptions(runtime.config),
  };
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodefleetError("ERR_VALIDATION", `${label} must be a non-empty string`);
  }
  return value;
}

function expectAgentRole(value: unknown, label: string): AgentRole {
  if (
    value !== "Orchestrator" &&
    value !== "Curator" &&
    value !== "Developer" &&
    value !== "Polisher" &&
    value !== "Gatekeeper" &&
    value !== "Reviewer"
  ) {
    throw new CodefleetError("ERR_VALIDATION", `${label} must be a valid agent role`);
  }
  return value;
}

function expectRuntimeStatus(value: unknown, label: string): AgentRuntime["status"] {
  if (value !== "starting" && value !== "running" && value !== "stopped" && value !== "failed") {
    throw new CodefleetError("ERR_VALIDATION", `${label} must be a valid runtime status`);
  }
  return value;
}

function expectSessionStatus(value: unknown, label: string): AgentSession["status"] {
  if (value !== "disconnected" && value !== "initializing" && value !== "ready" && value !== "error") {
    throw new CodefleetError("ERR_VALIDATION", `${label} must be a valid session status`);
  }
  return value;
}
