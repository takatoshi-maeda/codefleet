import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Command } from "commander";
import type { AgentRuntime } from "../../domain/agent-runtime-model.js";
import type { AppServerSession } from "../../domain/app-server-session-model.js";
import type { AgentRole } from "../../domain/roles-model.js";
import { FleetService } from "../../domain/agents/fleet-service.js";
import { BacklogService } from "../../domain/backlog/backlog-service.js";
import { AgentEventQueueService } from "../../domain/events/agent-event-queue-service.js";
import { AgentEventQueueWorkerService } from "../../domain/events/agent-event-queue-worker-service.js";
import { AppServerClient } from "../../infra/appserver/app-server-client.js";
import { BacklogPoller } from "../../events/watchers/backlog-poller.js";
import {
  formatAgentEventHumanLog,
  formatAgentEventNotificationLog,
  shouldSuppressNotificationMethod,
} from "../logging/fleet-agent-event-log.js";
import type { AgentEventQueueMessage } from "../../domain/events/agent-event-queue-message-model.js";
import type { SystemEvent } from "../../events/router.js";

interface FleetctlCommandOptions {
  commandName?: string;
}

const SUPERVISOR_PID_PATH = path.join(".codefleet", "runtime", "supervisor.pid");
const PLAYWRIGHT_SERVER_PID_PATH = path.join(".codefleet", "runtime", "playwright-server.pid");
const DEFAULT_QUEUE_CONSUME_MAX = 50;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_EPIC_READY_POLL_INTERVAL_MS = 3_000;
const DEFAULT_PLAYWRIGHT_HOST = "localhost";
const DEFAULT_PLAYWRIGHT_PORT = 9333;
const PLAYWRIGHT_READY_TIMEOUT_MS = 10_000;
const PLAYWRIGHT_SHUTDOWN_TIMEOUT_MS = 10_000;
const FORCE_EXIT_SIGNAL_ARM_DELAY_MS = 250;
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
  const lastAssistantMessageByAgent = new Map<string, string>();
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
        if (humanLog.message.startsWith("assistant: ")) {
          const previous = lastAssistantMessageByAgent.get(humanLog.agentId);
          if (previous === humanLog.message) {
            return;
          }
          lastAssistantMessageByAgent.set(humanLog.agentId, humanLog.message);
        }
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
    .option("--lang <lang>", "Set response language for newly started event threads")
    .option("--epic-ready-poll-interval-sec <seconds>", "Polling interval for backlog epic ready detection", "3")
    .option("--playwright-host <host>", "Host to bind playwright run-server", DEFAULT_PLAYWRIGHT_HOST)
    .option("--playwright-port <port>", "Port to bind playwright run-server", String(DEFAULT_PLAYWRIGHT_PORT))
    .option("--gatekeepers <count>", "Number of Gatekeeper agents", "1")
    .option("--developers <count>", "Number of Developer agents", "1")
    .option("--reviewers <count>", "Number of Reviewer agents", "1")
    .action(async (options) => {
      logMode = Boolean(options.verbose) ? "jsonl" : "human";
      const requestedAt = new Date().toISOString();
      const gatekeepers = Number(options.gatekeepers);
      const developers = Number(options.developers);
      const reviewers = Number(options.reviewers);
      const lang = typeof options.lang === "string" ? options.lang : undefined;
      const epicReadyPollIntervalMs = parsePositivePollIntervalMs(
        options.epicReadyPollIntervalSec,
        "--epic-ready-poll-interval-sec",
      );
      const playwrightHost = parsePlaywrightHost(options.playwrightHost);
      const playwrightPort = parsePlaywrightPort(options.playwrightPort);
      const requestedPlaywrightServerUrl = buildPlaywrightServerUrl(playwrightHost, playwrightPort);

      if (Boolean(options.detached)) {
        const detachedPid = await spawnDetachedSupervisorProcess({
          gatekeepers,
          developers,
          reviewers,
          verbose: Boolean(options.verbose),
          lang,
          epicReadyPollIntervalMs,
          playwrightHost,
          playwrightPort,
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
            reviewers,
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
          reviewers,
        },
        playwrightServerUrl: requestedPlaywrightServerUrl,
      });

      const playwrightServer = await startPlaywrightServer({ host: playwrightHost, port: playwrightPort }, emit);
      const queueWorker = new AgentEventQueueWorkerService();
      const queueService = new AgentEventQueueService();
      try {
        const status = await service.up({
          detached: false,
          gatekeepers,
          developers,
          reviewers,
          lang,
          playwrightServerUrl: playwrightServer.url,
        });
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

        await writeSupervisorPid(process.pid);
        try {
          await waitForShutdownSignal(service, queueWorker, queueService, emit, epicReadyPollIntervalMs);
        } finally {
          await removeSupervisorPidFile();
        }
      } finally {
        await stopPlaywrightServer(playwrightServer.pid, emit);
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
        await stopPlaywrightServerFromPidFile();
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
    .option("--reviewers <count>", "Number of Reviewer agents", "1")
    .action(async (options) => {
      const status = await service.restart({
        detached: Boolean(options.detached),
        gatekeepers: Number(options.gatekeepers),
        developers: Number(options.developers),
        reviewers: Number(options.reviewers),
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
  queueService: Pick<AgentEventQueueService, "enqueueToRunningAgents">,
  emit: (record: object) => void,
  epicReadyPollIntervalMs: number = DEFAULT_EPIC_READY_POLL_INTERVAL_MS,
): Promise<void> {
  let polling = true;
  let consuming = false;
  const backlogService = new BacklogService();

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
          {
            onMessage: async (message) => {
              const dispatchMessage = await prepareDispatchMessage(message, backlogService);
              if (!dispatchMessage) {
                return;
              }

              let emittedEvent;
              try {
                emittedEvent = await service.dispatchQueuedEvent(dispatchMessage);
                await finalizeEpicExecutionStatus(backlogService, dispatchMessage, message.agentId, null);
              } catch (error) {
                await finalizeEpicExecutionStatus(backlogService, dispatchMessage, message.agentId, error);
                throw error;
              }

              if (!emittedEvent) {
                return;
              }
              const enqueueResult = await queueService.enqueueToRunningAgents(emittedEvent);
              emit({
                ts: new Date().toISOString(),
                level: "info",
                event: "fleet.event.emitted",
                agentId: message.agentId,
                sourceEventType: message.event.type,
                emittedEventType: emittedEvent.type,
                enqueuedAgentIds: enqueueResult.enqueuedAgentIds,
              });
            },
          },
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
          for (const failure of result.failures) {
            emit({
              ts: new Date().toISOString(),
              level: "error",
              event: "fleet.queue.message_failed",
              agentId,
              file: failure.file,
              reason: failure.reason,
            });
          }
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

  const backlogPoller = new BacklogPoller(
    {
      publish: async (event) => {
        const enqueueResult = await queueService.enqueueToRunningAgents(event);
        if (enqueueResult.enqueuedAgentIds.length === 0) {
          return;
        }
        emit({
          ts: new Date().toISOString(),
          level: "info",
          event: "fleet.event.enqueued",
          source: "backlog-poller",
          sourceEventType: "backlog.epic.ready",
          enqueuedAgentIds: enqueueResult.enqueuedAgentIds,
        });
      },
    },
    epicReadyPollIntervalMs,
  );
  backlogPoller.start();

  await new Promise<void>((resolve) => {
    const watchedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const shutdownSignalTracker: ShutdownSignalTracker = { requestedAtMs: null };

    const cleanup = (): void => {
      polling = false;
      clearInterval(queueTimer);
      backlogPoller.stop();
      for (const signal of watchedSignals) {
        process.removeListener(signal, onSignal);
      }
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      const action = classifyShutdownSignal(shutdownSignalTracker, Date.now());
      if (action === "ignore") {
        return;
      }

      if (action === "force_exit") {
        emit({
          ts: new Date().toISOString(),
          level: "warn",
          event: "fleet.down.force_exit",
          signal,
        });
        process.exit(exitCodeForSignal(signal));
      }

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

interface ShutdownSignalTracker {
  requestedAtMs: number | null;
}

type ShutdownSignalAction = "start" | "ignore" | "force_exit";

export function classifyShutdownSignal(
  tracker: ShutdownSignalTracker,
  nowMs: number,
  armDelayMs: number = FORCE_EXIT_SIGNAL_ARM_DELAY_MS,
): ShutdownSignalAction {
  if (tracker.requestedAtMs === null) {
    tracker.requestedAtMs = nowMs;
    return "start";
  }

  // Some terminals/wrappers can fan out duplicate SIGINTs for a single Ctrl+C.
  // Ignore very-close repeats so graceful down can complete instead of being aborted.
  if (nowMs - tracker.requestedAtMs < armDelayMs) {
    return "ignore";
  }

  return "force_exit";
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  if (signal === "SIGTERM") {
    return 143;
  }
  return 130;
}

async function prepareDispatchMessage(
  message: AgentEventQueueMessage,
  backlogService: Pick<BacklogService, "claimReadyEpicForImplementation">,
): Promise<AgentEventQueueMessage | null> {
  if (message.event.type !== "backlog.epic.ready") {
    return message;
  }

  if (message.event.epicId) {
    // Explicit epic dispatch is used by review-requested rework. Skip auto-claiming.
    return message;
  }

  // Claiming at consume-time keeps enqueue cheap and avoids losing epics when
  // queued messages fail before an agent actually starts handling the task.
  const claimed = await backlogService.claimReadyEpicForImplementation(message.agentId);
  if (!claimed) {
    return null;
  }

  const event: SystemEvent = {
    type: "backlog.epic.ready",
    epicId: claimed.id,
  };
  return {
    ...message,
    event,
  };
}

async function finalizeEpicExecutionStatus(
  backlogService: Pick<BacklogService, "updateEpic">,
  message: AgentEventQueueMessage,
  actorId: string,
  error: unknown,
): Promise<void> {
  if (message.event.type !== "backlog.epic.ready" || !message.event.epicId) {
    return;
  }

  await backlogService.updateEpic({
    id: message.event.epicId,
    status: error ? "failed" : "in-review",
    force: true,
    actorId,
  });
}

function parsePositivePollIntervalMs(raw: unknown, optionName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return Math.max(1, Math.floor(value * 1_000));
}

function parsePlaywrightHost(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("--playwright-host must be a non-empty string");
  }
  const host = raw.trim();
  if (host.length === 0) {
    throw new Error("--playwright-host must be a non-empty string");
  }
  return host;
}

function parsePlaywrightPort(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("--playwright-port must be an integer between 1 and 65535");
  }
  return value;
}

function buildPlaywrightServerUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

interface PlaywrightServerStartResult {
  pid: number;
  url: string;
}

async function startPlaywrightServer(
  input: { host: string; port: number },
  emit: (record: object) => void,
): Promise<PlaywrightServerStartResult> {
  const existingPid = await readPlaywrightServerPid();
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(`playwright run-server is already running (pid=${existingPid})`);
  }
  if (existingPid) {
    await removePlaywrightServerPidFile();
  }

  const child = spawn(resolveNpxCommand(), ["playwright", "run-server", "--host", input.host, "--port", String(input.port)], {
    stdio: "ignore",
  });
  let spawnErrorMessage: string | null = null;
  child.once("error", (error) => {
    spawnErrorMessage = error instanceof Error ? error.message : String(error);
  });
  const pid = child.pid;
  if (!pid) {
    if (spawnErrorMessage) {
      throw new Error(`failed to start playwright run-server: ${spawnErrorMessage}`);
    }
    throw new Error("failed to start playwright run-server: no pid");
  }

  await writePlaywrightServerPid(pid);
  const url = buildPlaywrightServerUrl(input.host, input.port);
  try {
    await waitForPlaywrightServerReady({ host: input.host, port: input.port }, child, () => spawnErrorMessage);
  } catch (error) {
    await stopPlaywrightServer(pid, emit);
    throw error;
  }

  emit({
    ts: new Date().toISOString(),
    level: "info",
    event: "fleet.playwright.started",
    pid,
    url,
  });
  return { pid, url };
}

async function waitForPlaywrightServerReady(
  input: { host: string; port: number },
  child: { exitCode: number | null; signalCode: NodeJS.Signals | null },
  getSpawnError: () => string | null,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < PLAYWRIGHT_READY_TIMEOUT_MS) {
    const spawnErrorMessage = getSpawnError();
    if (spawnErrorMessage) {
      throw new Error(`failed to spawn playwright run-server: ${spawnErrorMessage}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `playwright run-server exited before becoming ready (exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
      );
    }
    const ready = await canConnectToTcpPort(input.host, input.port);
    if (ready) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for playwright run-server at ${buildPlaywrightServerUrl(input.host, input.port)}`);
}

function resolveNpxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

async function canConnectToTcpPort(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finalize = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finalize(true));
    socket.once("error", () => finalize(false));
    socket.setTimeout(250, () => finalize(false));
  });
}

async function stopPlaywrightServer(pid: number | null, emit?: (record: object) => void): Promise<void> {
  if (!pid) {
    await removePlaywrightServerPidFile();
    return;
  }

  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ESRCH") {
        throw error;
      }
    }
    await waitForProcessExit(pid, PLAYWRIGHT_SHUTDOWN_TIMEOUT_MS);
  }
  await removePlaywrightServerPidFile();
  emit?.({
    ts: new Date().toISOString(),
    level: "info",
    event: "fleet.playwright.stopped",
    pid,
  });
}

async function stopPlaywrightServerFromPidFile(): Promise<void> {
  const pid = await readPlaywrightServerPid();
  await stopPlaywrightServer(pid);
}

async function spawnDetachedSupervisorProcess(input: {
  gatekeepers: number;
  developers: number;
  reviewers: number;
  verbose: boolean;
  lang?: string;
  epicReadyPollIntervalMs: number;
  playwrightHost: string;
  playwrightPort: number;
}): Promise<number | null> {
  const args = [
    process.argv[1],
    "up",
    "--gatekeepers",
    String(input.gatekeepers),
    "--developers",
    String(input.developers),
    "--reviewers",
    String(input.reviewers),
  ];
  if (input.verbose) {
    args.push("--verbose");
  }
  if (input.lang) {
    args.push("--lang", input.lang);
  }
  if (input.epicReadyPollIntervalMs !== DEFAULT_EPIC_READY_POLL_INTERVAL_MS) {
    args.push("--epic-ready-poll-interval-sec", String(input.epicReadyPollIntervalMs / 1_000));
  }
  args.push("--playwright-host", input.playwrightHost, "--playwright-port", String(input.playwrightPort));
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

async function writePlaywrightServerPid(pid: number): Promise<void> {
  await fs.mkdir(path.dirname(PLAYWRIGHT_SERVER_PID_PATH), { recursive: true });
  await fs.writeFile(PLAYWRIGHT_SERVER_PID_PATH, `${pid}\n`, "utf8");
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

async function readPlaywrightServerPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PLAYWRIGHT_SERVER_PID_PATH, "utf8");
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

async function removePlaywrightServerPidFile(): Promise<void> {
  try {
    await fs.unlink(PLAYWRIGHT_SERVER_PID_PATH);
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

  if (event === "fleet.playwright.started") {
    const pid = typeof payload.pid === "number" ? payload.pid : "unknown";
    const url = typeof payload.url === "string" ? payload.url : "unknown";
    return `playwright server started pid=${pid} url=${url}`;
  }

  if (event === "fleet.playwright.stopped") {
    const pid = typeof payload.pid === "number" ? payload.pid : "unknown";
    return `playwright server stopped pid=${pid}`;
  }

  if (event === "fleet.queue.consumed") {
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "unknown-agent";
    const consumed = typeof payload.consumed === "number" ? payload.consumed : 0;
    const failedCount = typeof payload.failedCount === "number" ? payload.failedCount : 0;
    return `queue consumed agent=${agentId} consumed=${consumed} failed=${failedCount}`;
  }

  if (event === "fleet.queue.message_failed") {
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "unknown-agent";
    const file = typeof payload.file === "string" ? payload.file : "unknown-file";
    const reason = typeof payload.reason === "string" ? payload.reason : "unknown error";
    return `queue message failed agent=${agentId} file=${file} reason=${reason}`;
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
