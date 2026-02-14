import { spawn, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CodefleetError } from "../../shared/errors.js";
import type { AppServerSession } from "../../domain/app-server-session-model.js";
import type { AgentRole } from "../../domain/roles-model.js";

export interface StartAgentInput {
  agentId: string;
  role: AgentRole;
  prompt: string;
  cwd: string;
  detached: boolean;
  playwrightServerUrl?: string;
}

export interface StartAgentResult {
  pid: number | null;
  startedAt: string;
}

export interface StartTurnInput {
  threadId: string;
  input: Array<{ type: "text"; text: string }>;
}

export interface StartThreadInput {
  baseInstructions?: string;
  networkAccess?: boolean;
}

export interface AppServerNotification {
  agentId: string;
  method: string;
  params?: Record<string, unknown>;
  receivedAt: string;
}

export interface AppServerClientOptions {
  onNotification?: (notification: AppServerNotification) => void;
}

interface PendingResponse {
  resolve: (message: RpcResponseMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingTurnCompletion {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppServerConnection {
  agentId: string;
  startupPrompt: string;
  child: ChildProcessByStdio<Writable, Readable, null>;
  reader: readline.Interface;
  pending: Map<number, PendingResponse>;
  pendingTurnCompletions: Map<string, PendingTurnCompletion[]>;
  completedTurnKeys: string[];
  completedTurnKeySet: Set<string>;
  nextRequestId: number;
  lastNotificationAt: string;
}

type RpcResponseMessage = {
  id: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type RpcNotificationMessage = {
  method: string;
  params?: Record<string, unknown>;
};

const AGENT_APPROVAL_POLICY = "never";
const AGENT_SANDBOX_MODE = "workspace-write";
const AGENT_MODEL = "gpt-5.3-codex";
const AGENT_REASONING_EFFORT = "xhigh";
const AGENT_THREAD_NETWORK_ACCESS_DEFAULT = true;
const TURN_COMPLETION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_COMPLETED_TURN_CACHE = 256;

export class AppServerClient {
  private readonly connections = new Map<string, AppServerConnection>();

  constructor(private readonly options: AppServerClientOptions = {}) {}

  async startAgent(input: StartAgentInput): Promise<StartAgentResult> {
    // Role-specific prompts are passed through env to preserve a single startup entrypoint while
    // keeping role boot instructions explicit per lifecycle event trigger.
    const child = spawn("codex", ["-a", "never", "-s", "workspace-write", "app-server"], {
      cwd: input.cwd,
      detached: input.detached,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        CODEFLEET_AGENT_ID: input.agentId,
        CODEFLEET_AGENT_ROLE: input.role,
        CODEFLEET_ROLE_PROMPT: input.prompt,
        ...(input.playwrightServerUrl ? { CODEFLEET_PLAYWRIGHT_SERVER_URL: input.playwrightServerUrl } : {}),
      },
    });
    const reader = readline.createInterface({ input: child.stdout });
    const connection: AppServerConnection = {
      agentId: input.agentId,
      startupPrompt: input.prompt,
      child,
      reader,
      pending: new Map(),
      pendingTurnCompletions: new Map(),
      completedTurnKeys: [],
      completedTurnKeySet: new Set(),
      nextRequestId: 1,
      lastNotificationAt: new Date().toISOString(),
    };
    this.connections.set(input.agentId, connection);
    wireConnectionLifecycle(connection, this.connections, this.options.onNotification);

    if (input.detached) {
      child.unref();
    }

    return {
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
    };
  }

  async handshake(agentId: string): Promise<Pick<AppServerSession, "threadId" | "activeTurnId" | "lastNotificationAt">> {
    const connection = this.requireConnection(agentId);

    await sendRequest(connection, "initialize", {
      clientInfo: {
        name: "codefleet",
        title: "codefleet",
        version: "0.1.0",
      },
    });
    sendNotification(connection, "initialized", {});

    return {
      threadId: null,
      activeTurnId: null,
      lastNotificationAt: connection.lastNotificationAt,
    };
  }

  async startThread(agentId: string, input: StartThreadInput = {}): Promise<{ threadId: string; lastNotificationAt: string }> {
    const connection = this.requireConnection(agentId);
    const networkAccess = input.networkAccess ?? AGENT_THREAD_NETWORK_ACCESS_DEFAULT;
    // Pin thread defaults here so resumed work stays on the same model/policy without per-turn drift.
    const response = await sendRequest(connection, "thread/start", {
      approvalPolicy: AGENT_APPROVAL_POLICY,
      sandbox: AGENT_SANDBOX_MODE,
      // app-server applies this config override to the thread's workspace-write sandbox defaults.
      // We keep this explicit so outbound network enablement is controlled at thread bootstrap time.
      config: {
        sandbox_workspace_write: {
          network_access: networkAccess,
        },
      },
      model: AGENT_MODEL,
      baseInstructions: input.baseInstructions ?? null,
    });
    return {
      threadId: parseThreadId(response, "thread/start"),
      lastNotificationAt: connection.lastNotificationAt,
    };
  }

  async resumeThread(agentId: string, threadId: string): Promise<{ threadId: string; lastNotificationAt: string }> {
    const connection = this.requireConnection(agentId);
    // Keep model/policy consistent when resuming existing threads.
    const response = await sendRequest(connection, "thread/resume", {
      threadId,
      approvalPolicy: AGENT_APPROVAL_POLICY,
      sandbox: AGENT_SANDBOX_MODE,
      model: AGENT_MODEL,
    });
    return {
      threadId: parseThreadId(response, "thread/resume"),
      lastNotificationAt: connection.lastNotificationAt,
    };
  }

  async startTurn(agentId: string, input: StartTurnInput): Promise<{ turnId: string | null; lastNotificationAt: string }> {
    const connection = this.requireConnection(agentId);
    const response = await sendRequest(connection, "turn/start", {
      threadId: input.threadId,
      input: input.input,
      model: AGENT_MODEL,
      effort: AGENT_REASONING_EFFORT,
    });
    return {
      turnId: parseTurnId(response),
      lastNotificationAt: connection.lastNotificationAt,
    };
  }

  async waitForTurnCompletion(agentId: string, threadId: string, turnId: string): Promise<void> {
    const connection = this.requireConnection(agentId);
    const turnKey = `${threadId}:${turnId}`;
    if (connection.completedTurnKeySet.has(turnKey)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const pending = connection.pendingTurnCompletions.get(turnKey) ?? [];
      const timer = setTimeout(() => {
        const remaining = (connection.pendingTurnCompletions.get(turnKey) ?? []).filter((entry) => entry !== waiter);
        if (remaining.length > 0) {
          connection.pendingTurnCompletions.set(turnKey, remaining);
        } else {
          connection.pendingTurnCompletions.delete(turnKey);
        }
        reject(new CodefleetError("ERR_UNEXPECTED", `app-server turn timed out: ${turnKey}`));
      }, TURN_COMPLETION_TIMEOUT_MS);
      const waiter: PendingTurnCompletion = {
        resolve,
        reject,
        timer,
      };
      pending.push(waiter);
      connection.pendingTurnCompletions.set(turnKey, pending);
    });
  }

  private requireConnection(agentId: string): AppServerConnection {
    const connection = this.connections.get(agentId);
    if (!connection) {
      throw new CodefleetError("ERR_NOT_FOUND", `app-server process is not started for ${agentId}`);
    }
    return connection;
  }
}

function wireConnectionLifecycle(
  connection: AppServerConnection,
  connectionsByAgentId: Map<string, AppServerConnection>,
  onNotification?: (notification: AppServerNotification) => void,
): void {
  connection.reader.on("line", (line) => {
    const parsed = parseRpcLine(line);
    if (!parsed) {
      return;
    }

    connection.lastNotificationAt = new Date().toISOString();
    if ("id" in parsed && typeof parsed.id === "number") {
      const pending = connection.pending.get(parsed.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      connection.pending.delete(parsed.id);
      pending.resolve(parsed);
      return;
    }

    if ("method" in parsed) {
      if (parsed.method === "turn/completed") {
        const turnKey = parseTurnCompletionKey(parsed.params);
        if (turnKey) {
          markTurnCompleted(connection, turnKey);
        }
      }
      onNotification?.({
        agentId: connection.agentId,
        method: parsed.method,
        params: parsed.params,
        receivedAt: connection.lastNotificationAt,
      });
      return;
    }
  });

  const finalize = (message: string): void => {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodefleetError("ERR_UNEXPECTED", message));
    }
    for (const waiters of connection.pendingTurnCompletions.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new CodefleetError("ERR_UNEXPECTED", message));
      }
    }
    connection.pending.clear();
    connection.pendingTurnCompletions.clear();
    connection.reader.close();
    connectionsByAgentId.delete(connection.agentId);
  };

  connection.child.once("error", (error) => {
    finalize(`app-server process error for ${connection.agentId}: ${error.message}`);
  });

  connection.child.once("exit", (code, signal) => {
    finalize(`app-server process exited for ${connection.agentId} (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  });
}

async function sendRequest(
  connection: AppServerConnection,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResponseMessage> {
  const id = connection.nextRequestId++;
  const responsePromise = new Promise<RpcResponseMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(new CodefleetError("ERR_UNEXPECTED", `app-server request timed out: ${method}`));
    }, 10_000);
    connection.pending.set(id, { resolve, reject, timer });
  });

  writeRpcLine(connection, { method, id, params });
  const response = await responsePromise;
  if (response.error) {
    throw new CodefleetError(
      "ERR_UNEXPECTED",
      `app-server request failed: ${method}: ${response.error.message ?? "unknown error"}`,
    );
  }
  return response;
}

function sendNotification(connection: AppServerConnection, method: string, params: Record<string, unknown>): void {
  writeRpcLine(connection, { method, params });
}

function writeRpcLine(connection: AppServerConnection, message: Record<string, unknown>): void {
  if (connection.child.stdin.destroyed) {
    throw new CodefleetError("ERR_UNEXPECTED", "app-server stdin is not writable");
  }

  const payload = `${JSON.stringify(message)}\n`;
  connection.child.stdin.write(payload);
}

function parseRpcLine(line: string): RpcResponseMessage | RpcNotificationMessage | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as RpcResponseMessage | RpcNotificationMessage;
  } catch {
    return null;
  }
}

function parseThreadId(response: RpcResponseMessage, method: string): string {
  const thread = response.result?.thread as { id?: unknown } | undefined;
  if (typeof thread?.id === "string" && thread.id.length > 0) {
    return thread.id;
  }

  throw new CodefleetError("ERR_UNEXPECTED", `app-server request returned no thread id: ${method}`);
}

function parseTurnId(response: RpcResponseMessage): string | null {
  const turn = response.result?.turn as { id?: unknown } | undefined;
  return typeof turn?.id === "string" && turn.id.length > 0 ? turn.id : null;
}

function parseTurnCompletionKey(params: Record<string, unknown> | undefined): string | null {
  const threadId = typeof params?.threadId === "string" ? params.threadId : null;
  const turn = params?.turn as { id?: unknown } | undefined;
  const turnId = typeof turn?.id === "string" ? turn.id : null;
  if (!threadId || !turnId) {
    return null;
  }
  return `${threadId}:${turnId}`;
}

function markTurnCompleted(connection: AppServerConnection, turnKey: string): void {
  if (!connection.completedTurnKeySet.has(turnKey)) {
    connection.completedTurnKeySet.add(turnKey);
    connection.completedTurnKeys.push(turnKey);
    if (connection.completedTurnKeys.length > MAX_COMPLETED_TURN_CACHE) {
      const evicted = connection.completedTurnKeys.shift();
      if (evicted) {
        connection.completedTurnKeySet.delete(evicted);
      }
    }
  }

  const waiters = connection.pendingTurnCompletions.get(turnKey);
  if (!waiters) {
    return;
  }
  connection.pendingTurnCompletions.delete(turnKey);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}
