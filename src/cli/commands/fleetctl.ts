import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { AgentRuntime } from "../../domain/agent-runtime-model.js";
import type { AppServerSession } from "../../domain/app-server-session-model.js";
import type { AgentRole } from "../../domain/roles-model.js";
import { FleetService } from "../../domain/agents/fleet-service.js";
import { AgentEventQueueWorkerService } from "../../domain/events/agent-event-queue-worker-service.js";
import { AppServerClient } from "../../infra/appserver/app-server-client.js";
import {
  formatAgentEventHumanLog,
  formatAgentEventNotificationLog,
  shouldSuppressNotificationMethod,
} from "../logging/fleet-agent-event-log.js";

interface FleetctlCommandOptions {
  commandName?: string;
}

const SUPERVISOR_PID_PATH = path.join(".codefleet", "runtime", "supervisor.pid");
const DEFAULT_QUEUE_CONSUME_MAX = 50;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 1_000;
type LogMode = "human" | "jsonl";
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ROLE_COLOR_BY_PREFIX: Record<string, string> = {
  orchestrator: "\u001b[36m",
  gatekeeper: "\u001b[33m",
  developer: "\u001b[32m",
};

export function createFleetctlCommand(options: FleetctlCommandOptions = {}): Command {
  let logMode: LogMode = "human";
  const emit = (record: object): void => emitLog(record, logMode);
  const suppressedEventCountByAgent = new Map<string, number>();
  const appServerClient = new AppServerClient({
    onNotification: (notification) => {
      if (logMode === "jsonl") {
        if (shouldSuppressNotificationMethod(notification.method)) {
          suppressedEventCountByAgent.set(
            notification.agentId,
            (suppressedEventCountByAgent.get(notification.agentId) ?? 0) + 1,
          );
          return;
        }

        const logRecord = formatAgentEventNotificationLog(notification);
        const suppressedCount = suppressedEventCountByAgent.get(notification.agentId) ?? 0;
        if (suppressedCount > 0) {
          // Keep high-volume stream events out of the main log while preserving observability.
          logRecord.suppressedEventsSinceLast = suppressedCount;
          suppressedEventCountByAgent.set(notification.agentId, 0);
        }
        emit(logRecord);
        return;
      }

      const humanLog = formatAgentEventHumanLog(notification);
      if (humanLog) {
        emit({
          ts: humanLog.ts,
          level: humanLog.level,
          event: "fleet.agent.output",
          agentId: humanLog.agentId,
          message: humanLog.message,
        });
      }
    },
  });
  const service = new FleetService(undefined, undefined, undefined, undefined, appServerClient);
  const commandName = options.commandName ?? "fleetctl";

  const cmd = new Command(commandName);
  cmd.description("Control codefleet agent processes.");

  cmd
    .command("status")
    .description("Show agent runtime status")
    .option("--role <role>", "Filter by role")
    .action(async (options) => {
      const status = await service.status(options.role as AgentRole | undefined);
      console.log(JSON.stringify(status, null, 2));
    });

  cmd
    .command("up")
    .description("Start agents")
    .option("-d, --detached", "Run in background")
    .option("--verbose", "Emit verbose JSONL logs for diagnostics")
    .option("--gatekeepers <count>", "Number of Gatekeeper agents", "1")
    .option("--developers <count>", "Number of Developer agents", "1")
    .action(async (options) => {
      logMode = Boolean(options.verbose) ? "jsonl" : "human";
      const requestedAt = new Date().toISOString();
      const gatekeepers = Number(options.gatekeepers);
      const developers = Number(options.developers);

      if (Boolean(options.detached)) {
        const detachedPid = await spawnDetachedSupervisorProcess({
          gatekeepers,
          developers,
          verbose: Boolean(options.verbose),
        });
        emit({
          ts: requestedAt,
          level: "info",
          event: "fleet.supervisor.detached",
          pid: detachedPid,
          requestedRoles: {
            orchestrators: 1,
            gatekeepers,
            developers,
          },
        });
        return;
      }

      emit({
        ts: requestedAt,
        level: "info",
        event: "fleet.up.requested",
        detached: Boolean(options.detached),
        requestedRoles: {
          orchestrators: 1,
          gatekeepers,
          developers,
        },
      });

      const status = await service.up({ detached: false, gatekeepers, developers });
      for (const agent of status.agents) {
        emitAgentRuntimeLog(agent, emit);
      }

      for (const session of status.sessions) {
        emitSessionLog(session, emit);
      }

      emit({
        ts: new Date().toISOString(),
        level: "info",
        event: "fleet.up.completed",
        summary: status.summary,
        agentCount: status.agents.length,
        readySessionCount: status.sessions.filter((session) => session.status === "ready").length,
      });

      const queueWorker = new AgentEventQueueWorkerService();
      await writeSupervisorPid(process.pid);
      try {
        await waitForShutdownSignal(service, queueWorker, emit);
      } finally {
        await removeSupervisorPidFile();
      }
    });

  cmd
    .command("down")
    .description("Stop agents")
    .option("--all", "Stop all agents")
    .option("--role <role>", "Stop agents with the role")
    .action(async (options) => {
      validateTargetSelection(Boolean(options.all), options.role as AgentRole | undefined, "down");
      if (Boolean(options.all)) {
        const supervisorPid = await readSupervisorPid();
        if (supervisorPid !== null && supervisorPid !== process.pid && isProcessAlive(supervisorPid)) {
          process.kill(supervisorPid, "SIGTERM");
          await waitForProcessExit(supervisorPid, 10_000);
        }
      }
      const status = await service.down({ all: Boolean(options.all), role: options.role as AgentRole | undefined });
      console.log(JSON.stringify(status, null, 2));
    });

  cmd
    .command("restart")
    .description("Restart agents")
    .option("-d, --detached", "Run in background")
    .option("--gatekeepers <count>", "Number of Gatekeeper agents", "1")
    .option("--developers <count>", "Number of Developer agents", "1")
    .action(async (options) => {
      const status = await service.restart({
        detached: Boolean(options.detached),
        gatekeepers: Number(options.gatekeepers),
        developers: Number(options.developers),
      });
      console.log(JSON.stringify(status, null, 2));
    });

  cmd
    .command("logs")
    .description("Show aggregated logs")
    .option("--all", "Show logs for all agents")
    .option("--role <role>", "Show logs for the role")
    .option("--tail <count>", "Number of lines per agent", "200")
    .action(async (options) => {
      validateTargetSelection(Boolean(options.all), options.role as AgentRole | undefined, "logs");
      const logs = await service.logs({
        all: Boolean(options.all),
        role: options.role as AgentRole | undefined,
        tail: Number(options.tail),
      });
      console.log(logs);
    });

  return cmd;
}

function validateTargetSelection(all: boolean, role: AgentRole | undefined, commandName: string): void {
  if (all && role) {
    throw new Error(`${commandName}: --all and --role cannot be used together`);
  }

  if (!all && !role) {
    throw new Error(`${commandName}: either --all or --role is required`);
  }
}

function emitAgentRuntimeLog(agent: AgentRuntime, emit: (record: object) => void): void {
  emit({
    ts: new Date().toISOString(),
    level: agent.status === "failed" ? "error" : "info",
    event: "fleet.agent.state",
    agentId: agent.id,
    role: agent.role,
    status: agent.status,
    pid: agent.pid,
    cwd: agent.cwd,
    startedAt: agent.startedAt,
    lastHeartbeatAt: agent.lastHeartbeatAt,
    lastError: agent.lastError ?? null,
  });
}

function emitSessionLog(session: AppServerSession, emit: (record: object) => void): void {
  emit({
    ts: new Date().toISOString(),
    level: session.status === "error" ? "error" : "info",
    event: "fleet.session.state",
    agentId: session.agentId,
    status: session.status,
    initialized: session.initialized,
    threadId: session.threadId ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastNotificationAt: session.lastNotificationAt,
    lastError: session.lastError ?? null,
  });
}

function emitLog(record: object, mode: LogMode): void {
  if (mode === "jsonl") {
    console.log(JSON.stringify(record));
    return;
  }
  console.log(formatHumanLog(record));
}

async function waitForShutdownSignal(
  service: FleetService,
  queueWorker: Pick<AgentEventQueueWorkerService, "consume">,
  emit: (record: object) => void,
): Promise<void> {
  let polling = true;
  let consuming = false;

  const consumeLoop = async (): Promise<void> => {
    if (!polling || consuming) {
      return;
    }

    consuming = true;
    try {
      const status = await service.status();
      const runningAgentIds = status.agents
        .filter((agent) => agent.status === "running")
        .map((agent) => agent.id)
        .sort();
      for (const agentId of runningAgentIds) {
        const result = await queueWorker.consume(
          { agentId, maxMessages: DEFAULT_QUEUE_CONSUME_MAX },
          { onMessage: async (message) => service.dispatchQueuedEvent(message) },
        );
        if (result.consumed > 0) {
          emit({
            ts: new Date().toISOString(),
            level: result.failedFiles.length > 0 ? "warn" : "info",
            event: "fleet.queue.consumed",
            agentId,
            consumed: result.consumed,
            doneCount: result.doneFiles.length,
            failedCount: result.failedFiles.length,
            failures: result.failures,
          });
        }
      }
    } catch (error) {
      emit({
        ts: new Date().toISOString(),
        level: "error",
        event: "fleet.queue.consume_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      consuming = false;
    }
  };

  const queueTimer = setInterval(() => {
    void consumeLoop();
  }, DEFAULT_QUEUE_POLL_INTERVAL_MS);
  void consumeLoop();

  await new Promise<void>((resolve) => {
    const watchedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    let shuttingDown = false;

    const cleanup = (): void => {
      polling = false;
      clearInterval(queueTimer);
      for (const signal of watchedSignals) {
        process.removeListener(signal, onSignal);
      }
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        emit({
          ts: new Date().toISOString(),
          level: "warn",
          event: "fleet.down.force_exit",
          signal,
        });
        process.exit(130);
      }

      shuttingDown = true;
      void (async () => {
        emit({
          ts: new Date().toISOString(),
          level: "info",
          event: "fleet.down.requested",
          trigger: "signal",
          signal,
        });

        try {
          const status = await service.down({ all: true });
          for (const agent of status.agents) {
            emitAgentRuntimeLog(agent, emit);
          }
          for (const session of status.sessions) {
            emitSessionLog(session, emit);
          }
          emit({
            ts: new Date().toISOString(),
            level: "info",
            event: "fleet.down.completed",
            summary: status.summary,
            agentCount: status.agents.length,
          });
        } catch (error) {
          process.exitCode = 1;
          emit({
            ts: new Date().toISOString(),
            level: "error",
            event: "fleet.down.failed",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          cleanup();
          resolve();
        }
      })();
    };

    for (const signal of watchedSignals) {
      process.on(signal, onSignal);
    }
  });
}

async function spawnDetachedSupervisorProcess(input: {
  gatekeepers: number;
  developers: number;
  verbose: boolean;
}): Promise<number | null> {
  const args = [
    process.argv[1],
    "up",
    "--gatekeepers",
    String(input.gatekeepers),
    "--developers",
    String(input.developers),
  ];
  if (input.verbose) {
    args.push("--verbose");
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

async function writeSupervisorPid(pid: number): Promise<void> {
  await fs.mkdir(path.dirname(SUPERVISOR_PID_PATH), { recursive: true });
  await fs.writeFile(SUPERVISOR_PID_PATH, `${pid}\n`, "utf8");
}

async function readSupervisorPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(SUPERVISOR_PID_PATH, "utf8");
    const value = Number(raw.trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removeSupervisorPidFile(): Promise<void> {
  try {
    await fs.unlink(SUPERVISOR_PID_PATH);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function formatHumanLog(record: object): string {
  const payload = asRecord(record);
  if (!payload) {
    return String(record);
  }

  const ts = typeof payload.ts === "string" ? payload.ts : new Date().toISOString();
  const level = typeof payload.level === "string" ? payload.level.toUpperCase() : "INFO";
  const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const event = typeof payload.event === "string" ? payload.event : "event";
  const message = humanMessageForEvent(event, payload);
  if (agentId) {
    return `[${ts}] ${formatAgentLabel(agentId)} ${level} ${message}`;
  }
  return `[${ts}] ${level} ${message}`;
}

function humanMessageForEvent(event: string, payload: Record<string, unknown>): string {
  if (event === "fleet.agent.output") {
    const message = typeof payload.message === "string" ? payload.message : "";
    return message;
  }

  if (event === "fleet.agent.state") {
    const role = typeof payload.role === "string" ? payload.role : "UnknownRole";
    const status = typeof payload.status === "string" ? payload.status : "unknown";
    const pid = typeof payload.pid === "number" ? String(payload.pid) : "-";
    return `(${role}) status=${status} pid=${pid}`;
  }

  if (event === "fleet.session.state") {
    const status = typeof payload.status === "string" ? payload.status : "unknown";
    return `session status=${status}`;
  }

  if (event === "fleet.up.requested") {
    const detached = payload.detached === true ? "true" : "false";
    return `fleet start requested detached=${detached}`;
  }

  if (event === "fleet.up.completed") {
    const summary = typeof payload.summary === "string" ? payload.summary : "unknown";
    const agentCount = typeof payload.agentCount === "number" ? payload.agentCount : 0;
    const readySessions = typeof payload.readySessionCount === "number" ? payload.readySessionCount : 0;
    return `fleet started summary=${summary} agents=${agentCount} readySessions=${readySessions}`;
  }

  if (event === "fleet.queue.consumed") {
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "unknown-agent";
    const consumed = typeof payload.consumed === "number" ? payload.consumed : 0;
    const failedCount = typeof payload.failedCount === "number" ? payload.failedCount : 0;
    return `queue consumed agent=${agentId} consumed=${consumed} failed=${failedCount}`;
  }

  if (event === "fleet.down.requested") {
    const signal = typeof payload.signal === "string" ? payload.signal : "unknown";
    return `shutdown requested by ${signal}`;
  }

  if (event === "fleet.down.completed") {
    const summary = typeof payload.summary === "string" ? payload.summary : "unknown";
    const agentCount = typeof payload.agentCount === "number" ? payload.agentCount : 0;
    return `fleet stopped summary=${summary} agents=${agentCount}`;
  }

  if (event === "fleet.down.failed") {
    const message = typeof payload.message === "string" ? payload.message : "unknown error";
    return `fleet shutdown failed: ${message}`;
  }

  const compact = Object.entries(payload)
    .filter(([key]) => key !== "ts" && key !== "level" && key !== "event")
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
  return compact.length > 0 ? `${event} ${compact}` : event;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function formatAgentLabel(agentId: string): string {
  const rolePrefix = agentId.split("-", 1)[0] ?? "";
  const color = ROLE_COLOR_BY_PREFIX[rolePrefix] ?? "\u001b[90m";
  return `${color}${ANSI_BOLD}(${agentId})${ANSI_RESET}`;
}
