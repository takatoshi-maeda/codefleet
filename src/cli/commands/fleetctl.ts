import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import type { AgentRuntime } from "../../domain/agent-runtime-model.js";
import type { AppServerSession } from "../../domain/app-server-session-model.js";
import type { AgentRole } from "../../domain/roles-model.js";
import { FleetService } from "../../domain/agents/fleet-service.js";
import { FleetExecutionLog } from "../../domain/agents/fleet-execution-log.js";
import { McpApiServerLifecycle } from "../../api/mcp/fleet-api-server-lifecycle.js";
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
import { createUlid } from "../../shared/ulid.js";

interface FleetctlCommandOptions {
  commandName?: string;
}

interface FleetUpPreflightBacklogService {
  list(input?: { includeHidden?: boolean }): Promise<{
    epics: Array<{ id: string; status: string }>;
    items: Array<{ id: string; status: string }>;
  }>;
  resetInProgressToTodo(actorId?: string): Promise<{ updatedEpicIds: string[]; updatedItemIds: string[] }>;
}

interface FleetUpPreflightDependencies {
  backlogService: FleetUpPreflightBacklogService;
  confirm: (message: string) => Promise<boolean | null>;
  hasUncommittedChanges: () => Promise<boolean>;
  hardReset: () => Promise<void>;
  emit: (record: object) => void;
}

interface FleetStartupAutoRecoveryBacklogService {
  list(input?: { includeHidden?: boolean }): Promise<{
    epics: Array<{ id: string; status: string }>;
    items?: Array<{ id: string; status: string; epicId?: string }>;
  }>;
}

interface FleetStartupAutoRecoveryQueueService {
  enqueueToRunningAgents(event: SystemEvent): Promise<{
    enqueuedAgentIds: string[];
  }>;
}

interface DockerEnvironmentDependencies {
  fileExists: (path: string) => Promise<boolean>;
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
}

const SUPERVISOR_PID_PATH = path.join(".codefleet", "runtime", "supervisor.pid");
const PLAYWRIGHT_SERVER_PID_PATH = path.join(".codefleet", "runtime", "playwright-server.pid");
const DEFAULT_RUNTIME_DIR = path.join(".codefleet", "runtime");
const DOCKER_ENV_FILE_PATH = "/.dockerenv";
const DOCKER_CGROUP_PATHS = ["/proc/self/cgroup", "/proc/1/cgroup"] as const;
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
  polisher: "\u001b[34m",
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
  const service = new FleetService(
    undefined,
    undefined,
    undefined,
    undefined,
    appServerClient,
    undefined,
    undefined,
    new McpApiServerLifecycle(),
  );
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
    .option("--polishers <count>", "Number of Polisher agents", "1")
    .option("--reviewers <count>", "Number of Reviewer agents", "1")
    .option("--skip-startup-preflight", "Skip internal startup preflight checks", false)
    .action(async (options) => {
      await assertDockerContainerEnvironment();
      logMode = Boolean(options.verbose) ? "jsonl" : "human";
      const requestedAt = new Date().toISOString();
      const gatekeepers = Number(options.gatekeepers);
      const developers = Number(options.developers);
      const polishers = Number(options.polishers);
      const reviewers = Number(options.reviewers);
      const lang = typeof options.lang === "string" ? options.lang : undefined;
      const epicReadyPollIntervalMs = parsePositivePollIntervalMs(
        options.epicReadyPollIntervalSec,
        "--epic-ready-poll-interval-sec",
      );
      const playwrightHost = parsePlaywrightHost(options.playwrightHost);
      const playwrightPort = parsePlaywrightPort(options.playwrightPort);
      const requestedPlaywrightServerUrl = buildPlaywrightServerUrl(playwrightHost, playwrightPort);
      if (!Boolean(options.skipStartupPreflight)) {
        await runFleetUpPreflight({
          backlogService: new BacklogService(),
        confirm: (message) =>
          confirmPrompt({
            input: process.stdin,
            output: process.stderr,
            message,
          }),
          hasUncommittedChanges: hasGitUncommittedChanges,
          hardReset: runGitResetHard,
          emit,
        });
      }

      if (Boolean(options.detached)) {
        const detachedPid = await spawnDetachedSupervisorProcess({
          gatekeepers,
          developers,
          polishers,
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
            polishers,
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
          polishers,
          reviewers,
        },
        playwrightServerUrl: requestedPlaywrightServerUrl,
      });
      const staleRecovery = await recoverStaleQueueProcessingFiles();
      if (staleRecovery.recoveredCount > 0) {
        emit({
          ts: new Date().toISOString(),
          level: "warn",
          event: "fleet.queue.stale_recovered",
          recoveredCount: staleRecovery.recoveredCount,
        });
      }
      if (staleRecovery.skippedCount > 0) {
        emit({
          ts: new Date().toISOString(),
          level: "warn",
          event: "fleet.queue.stale_recovery_partial",
          skippedCount: staleRecovery.skippedCount,
        });
      }

      const queueWorker = new AgentEventQueueWorkerService();
      const queueService = new AgentEventQueueService();
      const status = await service.up({
        detached: false,
        gatekeepers,
        developers,
        polishers,
        reviewers,
        lang,
        // Do not auto-start playwright run-server from fleetctl up. The URL can still
        // point to an externally managed server (if one is already running).
        playwrightServerUrl: requestedPlaywrightServerUrl,
      });
      for (const agent of status.agents) {
        emitAgentRuntimeLog(agent, emit);
      }

      for (const session of status.sessions) {
        emitSessionLog(session, emit);
      }
      emitApiServerLog(status.apiServer, emit);

      emit({
        ts: new Date().toISOString(),
        level: "info",
        event: "fleet.up.completed",
        summary: status.summary,
        agentCount: status.agents.length,
        readySessionCount: status.sessions.filter((session) => session.status === "ready").length,
      });
      await runFleetStartupAutoRecovery({
        backlogService: new BacklogService(),
        queueService,
        emit,
      });

      await writeSupervisorPid(process.pid);
      try {
        await waitForShutdownSignal(service, queueWorker, queueService, emit, epicReadyPollIntervalMs);
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
    .option("--polishers <count>", "Number of Polisher agents", "1")
    .option("--reviewers <count>", "Number of Reviewer agents", "1")
    .action(async (options) => {
      const status = await service.restart({
        detached: Boolean(options.detached),
        gatekeepers: Number(options.gatekeepers),
        developers: Number(options.developers),
        polishers: Number(options.polishers),
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

export async function runFleetUpPreflight(deps: FleetUpPreflightDependencies): Promise<void> {
  const listed = await deps.backlogService.list({ includeHidden: true });
  const inProgressEpicIds = listed.epics.filter((epic) => epic.status === "in-progress").map((epic) => epic.id);
  const inProgressItemIds = listed.items.filter((item) => item.status === "in-progress").map((item) => item.id);
  if (inProgressEpicIds.length > 0 || inProgressItemIds.length > 0) {
    const confirmedBacklogReset = await deps.confirm(
      `in-progress の Epic ${inProgressEpicIds.length}件 / Item ${inProgressItemIds.length}件を todo に戻します。実行しますか？ [y/N] `,
    );
    if (confirmedBacklogReset === null) {
      deps.emit({
        ts: new Date().toISOString(),
        level: "warn",
        event: "fleet.preflight.backlog_in_progress_reset.skipped_non_interactive",
        inProgressEpicCount: inProgressEpicIds.length,
        inProgressItemCount: inProgressItemIds.length,
      });
    } else if (!confirmedBacklogReset) {
      throw new Error("fleet up cancelled: backlog in-progress reset was not confirmed.");
    } else {
      const reset = await deps.backlogService.resetInProgressToTodo();
      deps.emit({
        ts: new Date().toISOString(),
        level: "warn",
        event: "fleet.preflight.backlog_in_progress_reset",
        updatedEpicCount: reset.updatedEpicIds.length,
        updatedItemCount: reset.updatedItemIds.length,
        updatedEpicIds: reset.updatedEpicIds,
        updatedItemIds: reset.updatedItemIds,
      });
    }
  }

  const hasDirtyChanges = await deps.hasUncommittedChanges();
  if (!hasDirtyChanges) {
    return;
  }

  const confirmedGitReset = await deps.confirm(
    "未コミット変更と新規ファイルを `git reset --hard && git clean -fd` で破棄します。実行しますか？ [y/N] ",
  );
  if (confirmedGitReset === null) {
    deps.emit({
      ts: new Date().toISOString(),
      level: "warn",
      event: "fleet.preflight.git_reset_hard.skipped_non_interactive",
    });
    return;
  }
  if (!confirmedGitReset) {
    throw new Error("fleet up cancelled: git reset --hard was not confirmed.");
  }
  await deps.hardReset();
  deps.emit({
    ts: new Date().toISOString(),
    level: "warn",
    event: "fleet.preflight.git_reset_hard",
  });
}

export async function runFleetStartupAutoRecovery(
  deps: {
    backlogService: FleetStartupAutoRecoveryBacklogService;
    queueService: FleetStartupAutoRecoveryQueueService;
    emit: (record: object) => void;
  },
  runtimeDir: string = DEFAULT_RUNTIME_DIR,
): Promise<void> {
  const listed = await deps.backlogService.list({ includeHidden: true });
  const recoverableEpics = listed.epics
    .filter((epic) => epic.status === "in-progress" || epic.status === "in-review")
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  if (recoverableEpics.length === 0) {
    return;
  }
  const inProgressItemIds = (listed.items ?? [])
    .filter((item) => item.status === "in-progress")
    .map((item) => item.id)
    .sort();
  if (inProgressItemIds.length > 0) {
    deps.emit({
      ts: new Date().toISOString(),
      level: "warn",
      event: "fleet.startup.auto_recovery.item_in_progress_detected",
      inProgressItemCount: inProgressItemIds.length,
      inProgressItemIds,
    });
  }

  // Recover epics left in a mid-flight state after crash/restart by re-enqueueing
  // the next stage event inferred from current status and queue history.
  for (const epic of recoverableEpics) {
    const eventType = await resolveRecoveryEventTypeForEpic(runtimeDir, epic.id, epic.status);
    const enqueueResult = await deps.queueService.enqueueToRunningAgents({ type: eventType, epicId: epic.id });
    const enqueued = enqueueResult.enqueuedAgentIds.length > 0;
    deps.emit({
      ts: new Date().toISOString(),
      level: enqueued ? "warn" : "info",
      event: enqueued ? "fleet.startup.auto_recovery.enqueued" : "fleet.startup.auto_recovery.skipped",
      epicId: epic.id,
      epicStatus: epic.status,
      recoveredEventType: eventType,
      enqueuedAgentIds: enqueueResult.enqueuedAgentIds,
    });
  }
}

export async function assertDockerContainerEnvironment(
  deps: DockerEnvironmentDependencies = {
    fileExists,
    readFile: fs.readFile,
  },
): Promise<void> {
  const runningInDocker = await isRunningInDockerContainer(deps);
  if (runningInDocker) {
    return;
  }
  throw new Error("fleet up requires running inside a Docker container.");
}

export async function isRunningInDockerContainer(deps: DockerEnvironmentDependencies): Promise<boolean> {
  if (await deps.fileExists(DOCKER_ENV_FILE_PATH)) {
    return true;
  }

  // Some runtimes do not expose `/.dockerenv`; use cgroup markers as fallback.
  for (const cgroupPath of DOCKER_CGROUP_PATHS) {
    let content = "";
    try {
      content = await deps.readFile(cgroupPath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (/(^|\/)(docker|containerd)(\/|$)/u.test(content)) {
      return true;
    }
  }

  return false;
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

function emitApiServerLog(
  apiServer:
    | {
        state: "running" | "stopped" | "error";
        host: string;
        port: number;
        startedAt: string | null;
        lastError?: string;
      }
    | undefined,
  emit: (record: object) => void,
): void {
  if (!apiServer) {
    return;
  }

  emit({
    ts: new Date().toISOString(),
    level: apiServer.state === "error" ? "error" : "info",
    event: "fleet.api-server.state",
    state: apiServer.state,
    host: apiServer.host,
    port: apiServer.port,
    startedAt: apiServer.startedAt,
    ...(apiServer.lastError ? { message: apiServer.lastError } : {}),
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
  const executionLog = new FleetExecutionLog(path.join(DEFAULT_RUNTIME_DIR, "fleet", "executions.jsonl"));

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

              const startedAt = new Date().toISOString();
              const executionId = createUlid();
              await executionLog.append({
                executionId,
                agentId: dispatchMessage.agentId,
                role: dispatchMessage.agentRole,
                eventType: dispatchMessage.event.type,
                ...(isEpicScopedEvent(dispatchMessage.event) ? { epicId: dispatchMessage.event.epicId } : {}),
                queuedAt: message.createdAt,
                startedAt,
                status: "running",
              });

              let emittedEvent;
              try {
                emittedEvent = await service.dispatchQueuedEvent(dispatchMessage);
                const finishedAt = new Date().toISOString();
                await executionLog.append({
                  executionId,
                  agentId: dispatchMessage.agentId,
                  role: dispatchMessage.agentRole,
                  eventType: dispatchMessage.event.type,
                  ...(isEpicScopedEvent(dispatchMessage.event) ? { epicId: dispatchMessage.event.epicId } : {}),
                  queuedAt: message.createdAt,
                  startedAt,
                  finishedAt,
                  durationMs: Math.max(Date.parse(finishedAt) - Date.parse(startedAt), 0),
                  status: "success",
                });
                await finalizeEpicExecutionStatus(backlogService, dispatchMessage, message.agentId, null);
              } catch (error) {
                const finishedAt = new Date().toISOString();
                await executionLog.append({
                  executionId,
                  agentId: dispatchMessage.agentId,
                  role: dispatchMessage.agentRole,
                  eventType: dispatchMessage.event.type,
                  ...(isEpicScopedEvent(dispatchMessage.event) ? { epicId: dispatchMessage.event.epicId } : {}),
                  queuedAt: message.createdAt,
                  startedAt,
                  finishedAt,
                  durationMs: Math.max(Date.parse(finishedAt) - Date.parse(startedAt), 0),
                  status: "failed",
                  error: {
                    message: error instanceof Error ? error.message : String(error),
                  },
                });
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
          sourceEventType: event.type,
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
          emitApiServerLog(status.apiServer, emit);
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

interface StaleQueueRecoveryResult {
  recoveredCount: number;
  skippedCount: number;
}

export async function recoverStaleQueueProcessingFiles(runtimeDir: string = DEFAULT_RUNTIME_DIR): Promise<StaleQueueRecoveryResult> {
  const queueAgentsDir = path.join(runtimeDir, "events", "agents");
  let agentEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    agentEntries = await fs.readdir(queueAgentsDir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { recoveredCount: 0, skippedCount: 0 };
    }
    throw error;
  }

  let recoveredCount = 0;
  let skippedCount = 0;
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    const processingDir = path.join(queueAgentsDir, agentEntry.name, "processing");
    const pendingDir = path.join(queueAgentsDir, agentEntry.name, "pending");
    let processingFiles: string[] = [];
    try {
      processingFiles = (await fs.readdir(processingDir)).filter((entry) => entry.endsWith(".json")).sort();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (processingFiles.length === 0) {
      continue;
    }
    await fs.mkdir(pendingDir, { recursive: true });
    for (const fileName of processingFiles) {
      const sourcePath = path.join(processingDir, fileName);
      const targetPath = await resolveRecoveredPendingPath(pendingDir, fileName);
      try {
        await fs.rename(sourcePath, targetPath);
        recoveredCount += 1;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          continue;
        }
        skippedCount += 1;
      }
    }
  }

  return { recoveredCount, skippedCount };
}

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

function isEpicScopedEvent(event: SystemEvent): event is Extract<SystemEvent, { epicId: string }> {
  return (
    (event.type === "backlog.epic.ready" ||
      event.type === "backlog.epic.polish.ready" ||
      event.type === "backlog.epic.review.ready") &&
    typeof event.epicId === "string" &&
    event.epicId.length > 0
  );
}

async function confirmPrompt(input: {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream;
  message: string;
}): Promise<boolean | null> {
  if (!input.input.isTTY) {
    return null;
  }
  const rl = createInterface({
    input: input.input,
    output: input.output,
  });
  try {
    const answer = await rl.question(input.message);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function hasGitUncommittedChanges(): Promise<boolean> {
  if (!(await isInsideGitWorkTree())) {
    return false;
  }
  const status = await runGitCommand(["status", "--porcelain"], { captureStdout: true });
  return status.stdout.trim().length > 0;
}

async function runGitResetHard(): Promise<void> {
  if (!(await isInsideGitWorkTree())) {
    return;
  }
  await runGitCommand(["reset", "--hard"], { captureStdout: false });
  // reset --hard does not remove untracked files; clean is required to fully
  // restore a pristine working tree before fleet startup.
  await runGitCommand(["clean", "-fd"], { captureStdout: false });
}

async function isInsideGitWorkTree(): Promise<boolean> {
  try {
    const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"], { captureStdout: true });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function runGitCommand(
  args: string[],
  options: { captureStdout: boolean },
): Promise<{ stdout: string }> {
  return await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: options.captureStdout ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.captureStdout) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      const suffix = stderr.trim().length > 0 ? `: ${stderr.trim()}` : "";
      reject(new Error(`git ${args.join(" ")} failed (exit ${code ?? "unknown"})${suffix}`));
    });
  });
}

function parsePositivePollIntervalMs(raw: unknown, optionName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return Math.max(1, Math.floor(value * 1_000));
}

async function resolveRecoveryEventTypeForEpic(
  runtimeDir: string,
  epicId: string,
  epicStatus: string,
): Promise<"backlog.epic.ready" | "backlog.epic.polish.ready" | "backlog.epic.review.ready"> {
  if (epicStatus === "in-progress") {
    // Explicit epicId bypasses auto-claim and resumes interrupted implementation.
    return "backlog.epic.ready";
  }
  const latest = await readLatestEpicScopedTerminalEvent(runtimeDir, epicId);
  if (!latest) {
    return "backlog.epic.polish.ready";
  }
  if (latest.type === "backlog.epic.review.ready") {
    return "backlog.epic.review.ready";
  }
  if (latest.type === "backlog.epic.polish.ready" && latest.queueState === "done") {
    // Polishing finished previously, so restart from reviewer stage if handoff was lost.
    return "backlog.epic.review.ready";
  }
  return "backlog.epic.polish.ready";
}

async function readLatestEpicScopedTerminalEvent(
  runtimeDir: string,
  epicId: string,
): Promise<{
  createdAt: string;
  queueState: "done" | "failed";
  type: "backlog.epic.polish.ready" | "backlog.epic.review.ready";
} | null> {
  const events = await readEpicScopedTerminalEvents(runtimeDir, epicId);
  const latest = events
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return latest ?? null;
}

async function readEpicScopedTerminalEvents(
  runtimeDir: string,
  epicId: string,
): Promise<Array<{ createdAt: string; queueState: "done" | "failed"; type: "backlog.epic.polish.ready" | "backlog.epic.review.ready" }>> {
  const queueAgentsDir = path.join(runtimeDir, "events", "agents");
  let agentEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    agentEntries = await fs.readdir(queueAgentsDir, { withFileTypes: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const result: Array<{
    createdAt: string;
    queueState: "done" | "failed";
    type: "backlog.epic.polish.ready" | "backlog.epic.review.ready";
  }> = [];
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    for (const queueState of ["done", "failed"] as const) {
      const queueStateDir = path.join(queueAgentsDir, agentEntry.name, queueState);
      let queueStateFiles: string[] = [];
      try {
        queueStateFiles = (await fs.readdir(queueStateDir)).filter((entry) => entry.endsWith(".json"));
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const fileName of queueStateFiles) {
        const filePath = path.join(queueStateDir, fileName);
        const parsed = await readEpicTerminalEvent(filePath);
        if (!parsed || parsed.epicId !== epicId) {
          continue;
        }
        result.push({ createdAt: parsed.createdAt, queueState, type: parsed.type });
      }
    }
  }
  return result;
}

async function readEpicTerminalEvent(
  filePath: string,
): Promise<{ createdAt: string; epicId: string; type: "backlog.epic.polish.ready" | "backlog.epic.review.ready" } | null> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const createdAt = (parsed as { createdAt?: unknown }).createdAt;
  const event = (parsed as { event?: unknown }).event;
  if (typeof createdAt !== "string" || !event || typeof event !== "object") {
    return null;
  }
  const type = (event as { type?: unknown }).type;
  const eventEpicId = (event as { epicId?: unknown }).epicId;
  if (
    (type !== "backlog.epic.polish.ready" && type !== "backlog.epic.review.ready") ||
    typeof eventEpicId !== "string" ||
    eventEpicId.length === 0
  ) {
    return null;
  }
  return {
    createdAt,
    epicId: eventEpicId,
    type,
  };
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
  polishers: number;
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
    "--polishers",
    String(input.polishers),
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
  // Parent process already ran the interactive startup preflight.
  args.push("--skip-startup-preflight");
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

async function resolveRecoveredPendingPath(pendingDir: string, fileName: string): Promise<string> {
  const initialPath = path.join(pendingDir, fileName);
  if (!(await fileExists(initialPath))) {
    return initialPath;
  }
  const extension = path.extname(fileName);
  const baseName = extension.length > 0 ? fileName.slice(0, -extension.length) : fileName;
  for (let index = 1; index <= 1000; index += 1) {
    const recoveredName = `${baseName}.recovered-${Date.now()}-${index}${extension}`;
    const candidatePath = path.join(pendingDir, recoveredName);
    if (!(await fileExists(candidatePath))) {
      return candidatePath;
    }
  }
  throw new Error(`failed to resolve recovered pending path for ${fileName}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return false;
    }
    throw error;
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

  if (event === "fleet.api-server.state") {
    const state = typeof payload.state === "string" ? payload.state : "unknown";
    const host = typeof payload.host === "string" ? payload.host : "unknown-host";
    const port = typeof payload.port === "number" ? payload.port : "unknown-port";
    const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : "not-started";
    const message = typeof payload.message === "string" ? payload.message : null;
    if (message) {
      return `api server state=${state} endpoint=http://${host}:${port} startedAt=${startedAt} error=${message}`;
    }
    return `api server state=${state} endpoint=http://${host}:${port} startedAt=${startedAt}`;
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

  if (event === "fleet.queue.stale_recovered") {
    const recoveredCount = typeof payload.recoveredCount === "number" ? payload.recoveredCount : 0;
    return `recovered stale processing messages count=${recoveredCount}`;
  }

  if (event === "fleet.queue.stale_recovery_partial") {
    const skippedCount = typeof payload.skippedCount === "number" ? payload.skippedCount : 0;
    return `stale processing recovery skipped count=${skippedCount}`;
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
