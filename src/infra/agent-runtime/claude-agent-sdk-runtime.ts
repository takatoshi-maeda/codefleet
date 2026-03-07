import type {
  Options as ClaudeAgentSdkOptions,
  SDKMessage as ClaudeAgentSdkMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CodefleetError } from "../../shared/errors.js";
import type {
  AgentRuntimeEventListener,
  ExecuteRoleAgentInput,
  ExecuteRoleAgentResult,
  PrepareRoleAgentInput,
  PrepareRoleAgentResult,
  RoleAgentRuntime,
} from "../../domain/fleet/role-agent-runtime.js";
import { DefaultClaudeAgentSdkClient, type ClaudeAgentSdkClient } from "./claude-agent-sdk-client.js";

const SUPPORTED_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const;
const SUPPORTED_SETTING_SOURCES = ["user", "project", "local"] as const;

export class ClaudeAgentSdkRuntime implements RoleAgentRuntime {
  readonly provider = "claude-agent-sdk" as const;
  private readonly inFlightQueries = new Map<string, { close(): void }>();

  constructor(
    private readonly client: ClaudeAgentSdkClient = new DefaultClaudeAgentSdkClient(),
    private readonly onEvent?: AgentRuntimeEventListener,
  ) {}

  async prepareAgent(input: PrepareRoleAgentInput): Promise<PrepareRoleAgentResult> {
    const now = new Date().toISOString();
    validateClaudeRuntimeConfig(input.runtimeConfig);
    return {
      provider: this.provider,
      pid: null,
      startedAt: now,
      session: {
        conversationId: null,
        activeInvocationId: null,
        lastActivityAt: now,
      },
    };
  }

  async execute(input: ExecuteRoleAgentInput): Promise<ExecuteRoleAgentResult> {
    const options = buildClaudeQueryOptions(input);
    const claudeQuery = this.client.query({
      prompt: input.prompt,
      options,
    });
    this.inFlightQueries.set(input.agentId, claudeQuery);

    let lastActivityAt = new Date().toISOString();
    let conversationId = input.currentSession?.conversationId ?? null;
    let activeInvocationId = input.currentSession?.activeInvocationId ?? null;

    try {
      for await (const message of claudeQuery) {
        lastActivityAt = new Date().toISOString();
        conversationId = message.session_id;
        activeInvocationId = readInvocationId(message, activeInvocationId);
        this.onEvent?.(mapClaudeMessageToRuntimeEvent(input.agentId, message, conversationId, activeInvocationId));
      }
    } finally {
      this.inFlightQueries.delete(input.agentId);
    }

    return {
      provider: this.provider,
      session: {
        conversationId,
        activeInvocationId,
        lastActivityAt,
      },
    };
  }

  async shutdownAgent(agentId: string): Promise<void> {
    this.inFlightQueries.get(agentId)?.close();
    this.inFlightQueries.delete(agentId);
  }
}

function validateClaudeRuntimeConfig(runtimeConfig: Record<string, unknown>): void {
  if ("permissionMode" in runtimeConfig && !isSupportedPermissionMode(runtimeConfig.permissionMode)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime permissionMode is invalid");
  }
  if ("persistSession" in runtimeConfig && typeof runtimeConfig.persistSession !== "boolean") {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime persistSession must be a boolean");
  }
  if ("maxTurns" in runtimeConfig && (!Number.isInteger(runtimeConfig.maxTurns) || Number(runtimeConfig.maxTurns) < 1)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime maxTurns must be a positive integer");
  }
  if ("allowedTools" in runtimeConfig && !isStringArray(runtimeConfig.allowedTools)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime allowedTools must be a string[]");
  }
  if ("disallowedTools" in runtimeConfig && !isStringArray(runtimeConfig.disallowedTools)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime disallowedTools must be a string[]");
  }
  if ("settingSources" in runtimeConfig && !isSettingSourceArray(runtimeConfig.settingSources)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime settingSources must be an array of user/project/local");
  }
  if ("mcpServers" in runtimeConfig && !isRecord(runtimeConfig.mcpServers)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime mcpServers must be an object");
  }
  if ("systemPrompt" in runtimeConfig && !isValidSystemPrompt(runtimeConfig.systemPrompt)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime systemPrompt must be a string or claude_code preset");
  }
  if ("tools" in runtimeConfig && !isValidTools(runtimeConfig.tools)) {
    throw new CodefleetError("ERR_VALIDATION", "Claude runtime tools must be a string[] or claude_code preset");
  }
}

function buildClaudeQueryOptions(input: ExecuteRoleAgentInput): ClaudeAgentSdkOptions {
  validateClaudeRuntimeConfig(input.runtimeConfig);
  const persistSession = input.runtimeConfig.persistSession === true;
  const options: ClaudeAgentSdkOptions = {
    cwd: input.cwd,
    model: readOptionalString(input.runtimeConfig.model),
    permissionMode: isSupportedPermissionMode(input.runtimeConfig.permissionMode)
      ? input.runtimeConfig.permissionMode
      : undefined,
    allowedTools: isStringArray(input.runtimeConfig.allowedTools) ? input.runtimeConfig.allowedTools : undefined,
    disallowedTools: isStringArray(input.runtimeConfig.disallowedTools) ? input.runtimeConfig.disallowedTools : undefined,
    maxTurns: typeof input.runtimeConfig.maxTurns === "number" ? input.runtimeConfig.maxTurns : undefined,
    mcpServers: isRecord(input.runtimeConfig.mcpServers)
      ? (input.runtimeConfig.mcpServers as NonNullable<ClaudeAgentSdkOptions["mcpServers"]>)
      : undefined,
    settingSources: isSettingSourceArray(input.runtimeConfig.settingSources) ? input.runtimeConfig.settingSources : [],
    pathToClaudeCodeExecutable: readOptionalString(input.runtimeConfig.pathToClaudeCodeExecutable),
    systemPrompt: buildSystemPrompt(input.runtimeConfig.systemPrompt, input.role, input.responseLanguage),
    tools: buildTools(input.runtimeConfig.tools),
    env: {
      ...process.env,
      CODEFLEET_AGENT_ID: input.agentId,
      CODEFLEET_AGENT_ROLE: input.role,
    },
    ...(persistSession && input.currentSession?.conversationId ? { resume: input.currentSession.conversationId } : {}),
  };

  if (options.permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }
  return options;
}

function buildSystemPrompt(
  configuredSystemPrompt: unknown,
  role: ExecuteRoleAgentInput["role"],
  responseLanguage: string | undefined,
): NonNullable<ClaudeAgentSdkOptions["systemPrompt"]> {
  const startupPrompt = buildClaudeStartupPrompt(role, responseLanguage);
  if (typeof configuredSystemPrompt === "string") {
    return `${configuredSystemPrompt}\n\n${startupPrompt}`.trim();
  }
  if (isRecord(configuredSystemPrompt) && configuredSystemPrompt.type === "preset" && configuredSystemPrompt.preset === "claude_code") {
    const append = readOptionalString(configuredSystemPrompt.append);
    return {
      type: "preset",
      preset: "claude_code",
      append: append ? `${append}\n\n${startupPrompt}` : startupPrompt,
    };
  }
  return {
    type: "preset",
    preset: "claude_code",
    append: startupPrompt,
  };
}

function buildClaudeStartupPrompt(role: ExecuteRoleAgentInput["role"], responseLanguage: string | undefined): string {
  const instructions = [`Please take on the role of ${role} for this task.`];
  if (responseLanguage) {
    instructions.push(`All responses must be in ${responseLanguage}.`);
  }
  return instructions.join("\n");
}

function buildTools(configuredTools: unknown): NonNullable<ClaudeAgentSdkOptions["tools"]> {
  if (Array.isArray(configuredTools) && configuredTools.every((entry) => typeof entry === "string")) {
    return configuredTools;
  }
  if (isRecord(configuredTools) && configuredTools.type === "preset" && configuredTools.preset === "claude_code") {
    return { type: "preset", preset: "claude_code" };
  }
  return { type: "preset", preset: "claude_code" };
}

function readInvocationId(message: ClaudeAgentSdkMessage, fallback: string | null): string | null {
  if ("uuid" in message && typeof message.uuid === "string") {
    return message.uuid;
  }
  return fallback;
}

function mapClaudeMessageToRuntimeEvent(
  agentId: string,
  message: ClaudeAgentSdkMessage,
  conversationId: string | null,
  activeInvocationId: string | null,
) {
  if (message.type === "assistant") {
    return {
      agentId,
      provider: "claude-agent-sdk" as const,
      occurredAt: new Date().toISOString(),
      kind: "assistant_message" as const,
      message: readClaudeAssistantText(message),
      nativeType: "assistant",
      conversationId,
      activeInvocationId,
      payload: { type: message.type },
    };
  }

  if (message.type === "tool_progress") {
    return {
      agentId,
      provider: "claude-agent-sdk" as const,
      occurredAt: new Date().toISOString(),
      kind: "tool_started" as const,
      message: `tool start: ${message.tool_name}`,
      nativeType: "tool_progress",
      conversationId,
      activeInvocationId,
      payload: {
        tool_use_id: message.tool_use_id,
        tool_name: message.tool_name,
        elapsed_time_seconds: message.elapsed_time_seconds,
      },
    };
  }

  if (message.type === "system" && message.subtype === "init") {
    return {
      agentId,
      provider: "claude-agent-sdk" as const,
      occurredAt: new Date().toISOString(),
      kind: "conversation_started" as const,
      message: conversationId ? `conversation started: ${conversationId}` : "conversation started",
      nativeType: "system/init",
      conversationId,
      activeInvocationId,
      payload: {
        model: message.model,
        permissionMode: message.permissionMode,
      },
    };
  }

  if (message.type === "system" && message.subtype === "task_started") {
    return {
      agentId,
      provider: "claude-agent-sdk" as const,
      occurredAt: new Date().toISOString(),
      kind: "invocation_started" as const,
      message: message.description ? `invocation started: ${message.description}` : "invocation started",
      nativeType: "system/task_started",
      conversationId,
      activeInvocationId,
      payload: {
        task_id: message.task_id,
        description: message.description,
      },
    };
  }

  if (message.type === "system" && message.subtype === "task_notification") {
    return {
      agentId,
      provider: "claude-agent-sdk" as const,
      occurredAt: new Date().toISOString(),
      kind: "tool_finished" as const,
      message: `tool end: ${message.summary} status=${message.status}`,
      nativeType: "system/task_notification",
      conversationId,
      activeInvocationId,
      payload: {
        task_id: message.task_id,
        status: message.status,
        summary: message.summary,
      },
    };
  }

  if (message.type === "result") {
    return {
      agentId,
      provider: "claude-agent-sdk" as const,
      occurredAt: new Date().toISOString(),
      kind: "invocation_finished" as const,
      message:
        message.subtype === "success"
          ? "invocation finished"
          : `invocation finished with error: ${message.subtype}`,
      nativeType: `result/${message.subtype}`,
      conversationId,
      activeInvocationId,
      payload: {
        subtype: message.subtype,
        stop_reason: message.stop_reason,
      },
    };
  }

  return {
    agentId,
    provider: "claude-agent-sdk" as const,
    occurredAt: new Date().toISOString(),
    kind: "native" as const,
    nativeType:
      message.type === "system" && "subtype" in message
        ? `${message.type}/${String(message.subtype)}`
        : message.type,
    conversationId,
    activeInvocationId,
    payload: { type: message.type },
  };
}

function readClaudeAssistantText(message: Extract<ClaudeAgentSdkMessage, { type: "assistant" }>): string | undefined {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) => {
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return undefined;
    })
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  return text.length > 0 ? `assistant: ${text}` : undefined;
}

function isSupportedPermissionMode(value: unknown): value is NonNullable<ClaudeAgentSdkOptions["permissionMode"]> {
  return typeof value === "string" && SUPPORTED_PERMISSION_MODES.includes(value as (typeof SUPPORTED_PERMISSION_MODES)[number]);
}

function isSettingSourceArray(value: unknown): value is NonNullable<ClaudeAgentSdkOptions["settingSources"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => typeof entry === "string" && SUPPORTED_SETTING_SOURCES.includes(entry as (typeof SUPPORTED_SETTING_SOURCES)[number]),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSystemPrompt(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "string" ||
    (isRecord(value) &&
      value.type === "preset" &&
      value.preset === "claude_code" &&
      (value.append === undefined || readOptionalString(value.append) !== undefined))
  );
}

function isValidTools(value: unknown): boolean {
  return (
    value === undefined ||
    isStringArray(value) ||
    (isRecord(value) && value.type === "preset" && value.preset === "claude_code")
  );
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
