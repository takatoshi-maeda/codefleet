import { AppServerClient } from "../appserver/app-server-client.js";
import type {
  AgentRuntimeEventListener,
  ExecuteRoleAgentInput,
  ExecuteRoleAgentResult,
  PrepareRoleAgentInput,
  PrepareRoleAgentResult,
  RoleAgentRuntime,
} from "../../domain/fleet/role-agent-runtime.js";

export class CodexAppServerRuntime implements RoleAgentRuntime {
  readonly provider = "codex-app-server" as const;

  constructor(
    private readonly appServerClient: AppServerClient = new AppServerClient(),
    onEvent?: AgentRuntimeEventListener,
  ) {
    if (onEvent) {
      this.appServerClient.addNotificationListener((notification) => {
        onEvent(mapAppServerNotificationToRuntimeEvent(notification));
      });
    }
  }

  async prepareAgent(input: PrepareRoleAgentInput): Promise<PrepareRoleAgentResult> {
    const started = await this.appServerClient.startAgent({
      agentId: input.agentId,
      role: input.role,
      prompt: input.startupPrompt,
      cwd: input.cwd,
      detached: input.detached,
      playwrightServerUrl: input.playwrightServerUrl,
      codexConfig: input.runtimeConfig,
    });
    const handshake = await this.appServerClient.handshake(input.agentId);

    return {
      provider: this.provider,
      pid: started.pid,
      startedAt: started.startedAt,
      session: {
        conversationId: handshake.threadId ?? null,
        activeInvocationId: handshake.activeTurnId ?? null,
        lastActivityAt: handshake.lastNotificationAt,
      },
    };
  }

  async execute(input: ExecuteRoleAgentInput): Promise<ExecuteRoleAgentResult> {
    const startedThread = await this.appServerClient.startThread(input.agentId, {
      baseInstructions: buildThreadLanguageInstruction(input.responseLanguage),
      codexConfig: input.runtimeConfig,
    });
    const startedTurn = await this.appServerClient.startTurn(input.agentId, {
      threadId: startedThread.threadId,
      input: [{ type: "text", text: input.prompt }],
    });
    if (startedTurn.turnId) {
      await this.appServerClient.waitForTurnCompletion(input.agentId, startedThread.threadId, startedTurn.turnId);
    }

    return {
      provider: this.provider,
      session: {
        conversationId: startedThread.threadId,
        activeInvocationId: startedTurn.turnId,
        lastActivityAt: startedTurn.lastNotificationAt,
      },
    };
  }

  async shutdownAgent(agentId: string): Promise<void> {
    await this.appServerClient.shutdownAgent(agentId);
  }
}

function buildThreadLanguageInstruction(lang: string | undefined): string | undefined {
  if (!lang) {
    return undefined;
  }
  return `All responses must be in ${lang}.`;
}

function mapAppServerNotificationToRuntimeEvent(notification: {
  agentId: string;
  method: string;
  params?: Record<string, unknown>;
  receivedAt: string;
}) {
  const payload = notification.params;
  if (notification.method === "codex/event/exec_command_begin") {
    const msg = asRecord(payload?.msg);
    const command = readStringArray(msg, ["command"]);
    const cwd = readString(msg, ["cwd"]);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "tool_started" as const,
      message: command.length > 0 ? `tool start: ${command.join(" ")}${cwd ? ` (cwd: ${cwd})` : ""}` : "tool start",
      nativeType: notification.method,
      payload,
    };
  }

  if (notification.method === "codex/event/exec_command_end") {
    const msg = asRecord(payload?.msg);
    const command = readStringArray(msg, ["command"]);
    const exitCode = readNumber(msg, ["exit_code"]) ?? readNumber(msg, ["exitCode"]);
    const stderr = readString(msg, ["stderr"]);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "tool_finished" as const,
      message:
        command.length > 0
          ? `tool end: ${command.join(" ")} exit=${exitCode ?? "unknown"}${stderr ? " stderr=present" : ""}`
          : "tool end",
      nativeType: notification.method,
      payload,
    };
  }

  if (notification.method === "codex/event/agent_reasoning") {
    const msg = asRecord(payload?.msg);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "reasoning" as const,
      message: typeof msg?.text === "string" && msg.text.length > 0 ? `reasoning: ${msg.text}` : undefined,
      nativeType: notification.method,
      payload,
    };
  }

  if (notification.method === "codex/event/item_completed") {
    const msg = asRecord(payload?.msg);
    const item = asRecord(msg?.item);
    if (item?.type === "AgentMessage") {
      const text = extractTextFromContent(item.content);
      return {
        agentId: notification.agentId,
        provider: "codex-app-server" as const,
        occurredAt: notification.receivedAt,
        kind: "assistant_message" as const,
        message: text ? `assistant: ${text}` : undefined,
        nativeType: notification.method,
        payload,
      };
    }
    if (item?.type === "Reasoning") {
      const text = extractTextFromContent(item.content) ?? "<empty>";
      return {
        agentId: notification.agentId,
        provider: "codex-app-server" as const,
        occurredAt: notification.receivedAt,
        kind: "reasoning" as const,
        message: `reasoning: ${text}`,
        nativeType: notification.method,
        payload,
      };
    }
  }

  if (notification.method === "codex/event/agent_message") {
    const msg = asRecord(payload?.msg);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "assistant_message" as const,
      message: typeof msg?.message === "string" && msg.message.length > 0 ? `assistant: ${msg.message}` : undefined,
      nativeType: notification.method,
      payload,
    };
  }

  if (notification.method === "item/completed") {
    const item = asRecord(payload?.item);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "assistant_message" as const,
      message: item?.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0 ? `assistant: ${item.text}` : undefined,
      nativeType: notification.method,
      payload,
    };
  }

  if (notification.method === "thread/started") {
    const threadId = readString(payload, ["thread", "id"]);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "conversation_started" as const,
      message: threadId ? `conversation started: ${threadId}` : "conversation started",
      nativeType: notification.method,
      conversationId: threadId ?? null,
      payload,
    };
  }

  if (notification.method === "turn/started") {
    const threadId = readString(payload, ["threadId"]);
    const turnId = readString(payload, ["turn", "id"]);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "invocation_started" as const,
      message: threadId && turnId ? `invocation started: ${threadId}/${turnId}` : "invocation started",
      nativeType: notification.method,
      conversationId: threadId ?? null,
      activeInvocationId: turnId ?? null,
      payload,
    };
  }

  if (notification.method === "turn/completed") {
    const threadId = readString(payload, ["threadId"]);
    const turnId = readString(payload, ["turn", "id"]);
    return {
      agentId: notification.agentId,
      provider: "codex-app-server" as const,
      occurredAt: notification.receivedAt,
      kind: "invocation_finished" as const,
      message: threadId && turnId ? `invocation finished: ${threadId}/${turnId}` : "invocation finished",
      nativeType: notification.method,
      conversationId: threadId ?? null,
      activeInvocationId: turnId ?? null,
      payload,
    };
  }

  return {
    agentId: notification.agentId,
    provider: "codex-app-server" as const,
    occurredAt: notification.receivedAt,
    kind: "native" as const,
    nativeType: notification.method,
    payload,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return typeof current === "string" ? current : undefined;
}

function readStringArray(value: unknown, path: string[]): string[] {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) {
      return [];
    }
    current = record[segment];
  }
  return Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === "string") : [];
}

function readNumber(value: unknown, path: string[]): number | undefined {
  let current: unknown = value;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return typeof current === "number" ? current : undefined;
}

function extractTextFromContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((item) => {
      const record = asRecord(item);
      return typeof record?.text === "string" ? record.text : undefined;
    })
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}
