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
}

export interface StartAgentResult {
  pid: number | null;
  startedAt: string;
}

export interface StartTurnInput {
  threadId: string;
  input: string;
}

interface PendingResponse {
  resolve: (message: RpcResponseMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AppServerConnection {
  agentId: string;
  startupPrompt: string;
  child: ChildProcessByStdio<Writable, Readable, null>;
  reader: readline.Interface;
  pending: Map<number, PendingResponse>;
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

export class AppServerClient {
  private readonly connections = new Map<string, AppServerConnection>();

  async startAgent(input: StartAgentInput): Promise<StartAgentResult> {
    // Role-specific prompts are passed through env to preserve a single startup entrypoint while
    // keeping role boot instructions explicit per lifecycle event trigger.
    const child = spawn("codex", ["app-server"], {
      cwd: input.cwd,
      detached: input.detached,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        CODEFLEET_AGENT_ID: input.agentId,
        CODEFLEET_AGENT_ROLE: input.role,
        CODEFLEET_ROLE_PROMPT: input.prompt,
      },
    });
    const reader = readline.createInterface({ input: child.stdout });
    const connection: AppServerConnection = {
      agentId: input.agentId,
      startupPrompt: input.prompt,
      child,
      reader,
      pending: new Map(),
      nextRequestId: 1,
      lastNotificationAt: new Date().toISOString(),
    };
    this.connections.set(input.agentId, connection);
    wireConnectionLifecycle(connection, this.connections);

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

  async startThread(agentId: string): Promise<{ threadId: string; lastNotificationAt: string }> {
    const connection = this.requireConnection(agentId);
    const response = await sendRequest(connection, "thread/start", {});
    return {
      threadId: parseThreadId(response, "thread/start"),
      lastNotificationAt: connection.lastNotificationAt,
    };
  }

  async resumeThread(agentId: string, threadId: string): Promise<{ threadId: string; lastNotificationAt: string }> {
    const connection = this.requireConnection(agentId);
    const response = await sendRequest(connection, "thread/resume", { threadId });
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
    });
    return {
      turnId: parseTurnId(response),
      lastNotificationAt: connection.lastNotificationAt,
    };
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
      return;
    }
  });

  const finalize = (message: string): void => {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodefleetError("ERR_UNEXPECTED", message));
    }
    connection.pending.clear();
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
