import type { AppServerNotification } from "../../infra/appserver/app-server-client.js";

const SUPPRESSED_NOTIFICATION_METHODS = new Set([
  "account/rateLimits/updated",
  "item/agentMessage/delta",
  "item/completed",
  "item/started",
  "thread/tokenUsage/updated",
  "codex/event/agent_message_delta",
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
  method: string;
  summary: string;
  params?: unknown;
  suppressedEventsSinceLast?: number;
}

export interface FleetAgentHumanLogRecord {
  ts: string;
  level: "info" | "warn" | "error";
  agentId: string;
  message: string;
}

export function shouldSuppressNotificationMethod(method: string): boolean {
  return SUPPRESSED_NOTIFICATION_METHODS.has(method);
}

export function formatAgentEventNotificationLog(notification: AppServerNotification): FleetAgentEventLogRecord {
  const params = summarizeNotificationParams(notification.method, notification.params);
  return {
    ts: notification.receivedAt,
    level: "info",
    event: "fleet.agent.event",
    agentId: notification.agentId,
    method: notification.method,
    summary: buildSummary(notification.method, params),
    params,
  };
}

export function formatAgentEventHumanLog(notification: AppServerNotification): FleetAgentHumanLogRecord | null {
  if (notification.method === "codex/event/exec_command_begin") {
    const msg = asRecord(notification.params?.msg);
    const command = readStringArray(msg, ["command"]);
    const cwd = readString(msg, ["cwd"]);
    if (command.length === 0) {
      return null;
    }
    return {
      ts: notification.receivedAt,
      level: "info",
      agentId: notification.agentId,
      message: `tool start: ${command.join(" ")}${cwd ? ` (cwd: ${cwd})` : ""}`,
    };
  }

  if (notification.method === "codex/event/exec_command_end") {
    const msg = asRecord(notification.params?.msg);
    const command = readStringArray(msg, ["command"]);
    const exitCode = readNumber(msg, ["exit_code"]) ?? readNumber(msg, ["exitCode"]);
    const stderr = readString(msg, ["stderr"]);
    const level: FleetAgentHumanLogRecord["level"] = typeof exitCode === "number" && exitCode !== 0 ? "error" : "info";
    if (command.length === 0) {
      return null;
    }
    return {
      ts: notification.receivedAt,
      level,
      agentId: notification.agentId,
      message: `tool end: ${command.join(" ")} exit=${exitCode ?? "unknown"}${stderr ? " stderr=present" : ""}`,
    };
  }

  if (notification.method === "codex/event/agent_reasoning") {
    const msg = asRecord(notification.params?.msg);
    if (typeof msg?.text === "string" && msg.text.length > 0) {
      return {
        ts: notification.receivedAt,
        level: "info",
        agentId: notification.agentId,
        message: `reasoning: ${msg.text}`,
      };
    }
    return null;
  }

  if (notification.method === "codex/event/item_completed") {
    const msg = asRecord(notification.params?.msg);
    const item = asRecord(msg?.item);
    if (item?.type !== "AgentMessage") {
      return null;
    }

    const textFromContent = extractAgentMessageTextFromContent(item.content);
    if (!textFromContent) {
      return null;
    }
    return {
      ts: notification.receivedAt,
      level: "info",
      agentId: notification.agentId,
      message: `assistant: ${textFromContent}`,
    };
  }

  if (notification.method === "codex/event/agent_message") {
    const msg = asRecord(notification.params?.msg);
    if (typeof msg?.message === "string" && msg.message.length > 0) {
      return {
        ts: notification.receivedAt,
        level: "info",
        agentId: notification.agentId,
        message: `assistant: ${msg.message}`,
      };
    }
    return null;
  }

  if (notification.method === "item/completed") {
    const item = asRecord(notification.params?.item);
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.length > 0) {
      return {
        ts: notification.receivedAt,
        level: "info",
        agentId: notification.agentId,
        // Emit only completed parts so logs stay readable and avoid token-by-token deltas.
        message: `assistant: ${item.text}`,
      };
    }
    return null;
  }

  if (notification.method === "codex/event/exec_approval_request") {
    const params = summarizeNotificationParams(notification.method, notification.params);
    const command = readStringArray(params, ["command"]);
    return {
      ts: notification.receivedAt,
      level: "warn",
      agentId: notification.agentId,
      message: command.length > 0 ? `approval requested: ${command.join(" ")}` : "approval requested",
    };
  }

  if (notification.method === "thread/started") {
    const params = summarizeNotificationParams(notification.method, notification.params);
    const threadId = readString(params, ["thread", "id"]);
    return {
      ts: notification.receivedAt,
      level: "info",
      agentId: notification.agentId,
      message: threadId ? `thread started: ${threadId}` : "thread started",
    };
  }

  if (notification.method === "turn/started") {
    const params = summarizeNotificationParams(notification.method, notification.params);
    const threadId = readString(params, ["threadId"]);
    const turnId = readString(params, ["turn", "id"]);
    return {
      ts: notification.receivedAt,
      level: "info",
      agentId: notification.agentId,
      message: threadId && turnId ? `turn started: ${threadId}/${turnId}` : "turn started",
    };
  }

  if (notification.method === "turn/completed") {
    const params = summarizeNotificationParams(notification.method, notification.params);
    const threadId = readString(params, ["threadId"]);
    const turnId = readString(params, ["turn", "id"]);
    return {
      ts: notification.receivedAt,
      level: "info",
      agentId: notification.agentId,
      message: threadId && turnId ? `turn completed: ${threadId}/${turnId}` : "turn completed",
    };
  }

  return null;
}

function summarizeNotificationParams(method: string, params: Record<string, unknown> | undefined): unknown {
  if (!params) {
    return undefined;
  }

  if (method === "codex/event/exec_approval_request") {
    const msg = asRecord(params.msg);
    const command = Array.isArray(msg?.command) ? msg.command.filter((value) => typeof value === "string") : [];
    return {
      command: command.slice(0, 6),
      cwd: typeof msg?.cwd === "string" ? msg.cwd : undefined,
      reason: typeof msg?.reason === "string" ? truncateText(msg.reason) : undefined,
    };
  }

  if (method === "codex/event/agent_message") {
    const msg = asRecord(params.msg);
    return {
      message: typeof msg?.message === "string" ? truncateText(msg.message) : undefined,
    };
  }

  if (method === "codex/event/token_count") {
    const msg = asRecord(params.msg);
    const info = asRecord(msg?.info);
    const total = asRecord(info?.total_token_usage);
    const last = asRecord(info?.last_token_usage);
    return {
      totalTokens: typeof total?.total_tokens === "number" ? total.total_tokens : undefined,
      inputTokens: typeof total?.input_tokens === "number" ? total.input_tokens : undefined,
      outputTokens: typeof total?.output_tokens === "number" ? total.output_tokens : undefined,
      lastTotalTokens: typeof last?.total_tokens === "number" ? last.total_tokens : undefined,
    };
  }

  return sanitizeForLog(params, 0);
}

function buildSummary(method: string, params: unknown): string {
  if (method === "thread/started") {
    const threadId = readString(params, ["thread", "id"]);
    return threadId ? `thread started: ${threadId}` : "thread started";
  }

  if (method === "turn/started") {
    const threadId = readString(params, ["threadId"]);
    const turnId = readString(params, ["turn", "id"]);
    if (threadId && turnId) {
      return `turn started: ${threadId}/${turnId}`;
    }
    return "turn started";
  }

  if (method === "codex/event/exec_approval_request") {
    const command = readStringArray(params, ["command"]);
    if (command.length > 0) {
      return `approval requested: ${command.join(" ")}`;
    }
    return "approval requested";
  }

  if (method === "codex/event/agent_message") {
    const message = readString(params, ["message"]);
    return message ? `agent message: ${message}` : "agent message";
  }

  if (method === "codex/event/item_started") {
    const itemType = readString(params, ["msg", "item", "type"]);
    return itemType ? `item started: ${itemType}` : "item started";
  }

  if (method === "codex/event/item_completed") {
    const itemType = readString(params, ["msg", "item", "type"]);
    return itemType ? `item completed: ${itemType}` : "item completed";
  }

  if (method === "codex/event/task_started") {
    return "task started";
  }

  if (method === "codex/event/task_completed") {
    return "task completed";
  }

  return method;
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
  if (!Array.isArray(current)) {
    return [];
  }
  return current.filter((item): item is string => typeof item === "string");
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function truncateText(value: string): string {
  if (value.length <= MAX_LOG_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_LOG_STRING_LENGTH)}... [truncated ${value.length - MAX_LOG_STRING_LENGTH} chars]`;
}

function extractAgentMessageTextFromContent(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const text = record.text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  const merged = parts.join("\n").trim();
  return merged.length > 0 ? merged : null;
}
