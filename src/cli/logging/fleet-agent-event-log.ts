import type { AgentRuntimeEvent } from "../../domain/fleet/role-agent-runtime.js";

const SUPPRESSED_NATIVE_EVENT_TYPES = new Set([
  "account/rateLimits/updated",
  "item/agentMessage/delta",
  "item/completed",
  "item/started",
  "thread/tokenUsage/updated",
  "codex/event/agent_message_delta",
  "stream_event",
  "system/task_progress",
  "system/status",
]);

const MAX_LOG_STRING_LENGTH = 180;
const MAX_LOG_ARRAY_LENGTH = 4;
const MAX_LOG_OBJECT_KEYS = 10;
const MAX_LOG_DEPTH = 4;

export interface FleetAgentEventLogRecord {
  ts: string;
  level: "info";
  event: "fleet.agent.event";
  agentId: string;
  provider: AgentRuntimeEvent["provider"];
  kind: AgentRuntimeEvent["kind"];
  nativeType?: string;
  summary: string;
  payload?: unknown;
  suppressedEventsSinceLast?: number;
}

export interface FleetAgentHumanLogRecord {
  ts: string;
  level: "info" | "warn" | "error";
  agentId: string;
  message: string;
}

export type FleetAgentConsoleLogRecord =
  | {
      ts: string;
      level: "info" | "warn" | "error";
      event: "fleet.agent.output";
      agentId: string;
      message: string;
    }
  | {
      ts: string;
      level: "info";
      event: "fleet.agent.event";
      agentId: string;
      provider: AgentRuntimeEvent["provider"];
      kind: AgentRuntimeEvent["kind"];
      nativeType?: string;
      summary: string;
    };

export interface FleetAgentConsoleLogDecision {
  willEmit: boolean;
  reason: "allowed" | "human_log_unavailable" | "message_not_allowed";
  message?: string;
  level?: "info" | "warn" | "error";
  extractedHumanMessage?: string;
}

export function shouldSuppressAgentRuntimeEvent(event: AgentRuntimeEvent): boolean {
  return event.kind === "native" && typeof event.nativeType === "string" && SUPPRESSED_NATIVE_EVENT_TYPES.has(event.nativeType);
}

export function formatAgentRuntimeEventLog(event: AgentRuntimeEvent): FleetAgentEventLogRecord {
  const payload = summarizePayload(event);
  return {
    ts: event.occurredAt,
    level: "info",
    event: "fleet.agent.event",
    agentId: event.agentId,
    provider: event.provider,
    kind: event.kind,
    ...(event.nativeType ? { nativeType: event.nativeType } : {}),
    summary: buildSummary(event, payload),
    ...(payload === undefined ? {} : { payload }),
  };
}

export function formatAgentRuntimeHumanLog(event: AgentRuntimeEvent): FleetAgentHumanLogRecord | null {
  const message = event.message?.trim();
  if (!message) {
    return null;
  }
  const level: FleetAgentHumanLogRecord["level"] = event.nativeType === "codex/event/exec_approval_request" ? "warn" : "info";
  return {
    ts: event.occurredAt,
    level,
    agentId: event.agentId,
    message,
  };
}

export function formatAgentRuntimeConsoleLog(event: AgentRuntimeEvent): FleetAgentConsoleLogRecord | null {
  const decision = diagnoseAgentRuntimeConsoleLog(event);
  if (!decision.willEmit || !decision.message) {
    return null;
  }

  return {
    ts: event.occurredAt,
    level: decision.level ?? "info",
    event: "fleet.agent.output",
    agentId: event.agentId,
    message: decision.message,
  };
}

export function diagnoseAgentRuntimeConsoleLog(event: AgentRuntimeEvent): FleetAgentConsoleLogDecision {
  const human = formatAgentRuntimeHumanLog(event);
  if (!human) {
    return {
      willEmit: false,
      reason: "human_log_unavailable",
    };
  }
  if (!isAllowedConsoleMessage(human.message)) {
    return {
      willEmit: false,
      reason: "message_not_allowed",
      extractedHumanMessage: human.message,
    };
  }
  return {
    willEmit: true,
    reason: "allowed",
    message: human.message,
    level: human.level,
    extractedHumanMessage: human.message,
  };
}

function isAllowedConsoleMessage(message: string): boolean {
  return (
    message.startsWith("tool start: ") ||
    message.startsWith("tool end: ") ||
    message.startsWith("reasoning: ") ||
    message.startsWith("assistant: ") ||
    message.startsWith("conversation started: ") ||
    message.startsWith("invocation started: ") ||
    message.startsWith("invocation finished")
  );
}

function summarizePayload(event: AgentRuntimeEvent): unknown {
  if (!event.payload) {
    return undefined;
  }

  if (event.nativeType === "codex/event/exec_approval_request") {
    const command = readStringArray(event.payload, ["msg", "command"]);
    return {
      command: command.slice(0, 6),
      cwd: readString(event.payload, ["msg", "cwd"]),
      reason: readString(event.payload, ["msg", "reason"]),
    };
  }

  if (event.nativeType === "codex/event/agent_message") {
    return {
      message: readString(event.payload, ["msg", "message"]),
    };
  }

  return sanitizeForLog(event.payload, 0);
}

function buildSummary(event: AgentRuntimeEvent, payload: unknown): string {
  if (event.message) {
    return truncateText(event.message);
  }

  if (event.kind === "native" && event.nativeType) {
    if (event.nativeType === "thread/started") {
      const conversationId = readString(payload, ["thread", "id"]);
      return conversationId ? `conversation started: ${conversationId}` : "conversation started";
    }
    if (event.nativeType === "turn/started") {
      const conversationId = readString(payload, ["threadId"]);
      const invocationId = readString(payload, ["turn", "id"]);
      return conversationId && invocationId
        ? `invocation started: ${conversationId}/${invocationId}`
        : "invocation started";
    }
    if (event.nativeType === "turn/completed") {
      const conversationId = readString(payload, ["threadId"]);
      const invocationId = readString(payload, ["turn", "id"]);
      return conversationId && invocationId
        ? `invocation finished: ${conversationId}/${invocationId}`
        : "invocation finished";
    }
    return event.nativeType;
  }

  return event.kind.replaceAll("_", " ");
}

function sanitizeForLog(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value);
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_DEPTH) {
      return `[array(${value.length})]`;
    }
    const trimmed = value.slice(0, MAX_LOG_ARRAY_LENGTH).map((item) => sanitizeForLog(item, depth + 1));
    if (value.length > MAX_LOG_ARRAY_LENGTH) {
      trimmed.push(`...(+${value.length - MAX_LOG_ARRAY_LENGTH} more)`);
    }
    return trimmed;
  }

  if (typeof value === "object") {
    const record = asRecord(value);
    if (!record) {
      return undefined;
    }
    if (depth >= MAX_LOG_DEPTH) {
      return `[object(${Object.keys(record).length} keys)]`;
    }
    const entries = Object.entries(record);
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
      result[key] = sanitizeForLog(item, depth + 1);
    }
    if (entries.length > MAX_LOG_OBJECT_KEYS) {
      result._truncatedKeys = entries.length - MAX_LOG_OBJECT_KEYS;
    }
    return result;
  }

  return String(value);
}

function truncateText(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}...[truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
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
