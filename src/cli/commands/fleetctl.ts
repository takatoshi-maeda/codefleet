import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { AgentRuntime } from "../../domain/agent-runtime-model.js";
import type { AppServerSession } from "../../domain/app-server-session-model.js";
import type { AgentRole } from "../../domain/roles-model.js";
import { FleetService } from "../../domain/agents/fleet-service.js";
import { AgentEventQueueWorkerService } from "../../domain/events/agent-event-queue-worker-service.js";

interface FleetctlCommandOptions {
  commandName?: string;
}

const SUPERVISOR_PID_PATH = path.join(".codefleet", "runtime", "supervisor.pid");
const DEFAULT_QUEUE_CONSUME_MAX = 50;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 1_000;

export function createFleetctlCommand(options: FleetctlCommandOptions = {}): Command {
  const service = new FleetService();
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
    .option("--gatekeepers <count>", "Number of Gatekeeper agents", "1")
    .option("--developers <count>", "Number of Developer agents", "1")
    .action(async (options) => {
      const requestedAt = new Date().toISOString();
      const gatekeepers = Number(options.gatekeepers);
      const developers = Number(options.developers);

      if (Boolean(options.detached)) {
        const detachedPid = await spawnDetachedSupervisorProcess({ gatekeepers, developers });
        emitJsonl({
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

      emitJsonl({
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
        emitAgentRuntimeLog(agent);
      }

      for (const session of status.sessions) {
        emitSessionLog(session);
      }

      emitJsonl({
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
        await waitForShutdownSignal(service, queueWorker);
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

function emitAgentRuntimeLog(agent: AgentRuntime): void {
  emitJsonl({
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

function emitSessionLog(session: AppServerSession): void {
  emitJsonl({
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

function emitJsonl(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

async function waitForShutdownSignal(
  service: FleetService,
  queueWorker: Pick<AgentEventQueueWorkerService, "consume">,
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
          emitJsonl({
            ts: new Date().toISOString(),
            level: "info",
            event: "fleet.queue.consumed",
            agentId,
            consumed: result.consumed,
            doneCount: result.doneFiles.length,
            failedCount: result.failedFiles.length,
          });
        }
      }
    } catch (error) {
      emitJsonl({
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
        emitJsonl({
          ts: new Date().toISOString(),
          level: "warn",
          event: "fleet.down.force_exit",
          signal,
        });
        process.exit(130);
      }

      shuttingDown = true;
      void (async () => {
        emitJsonl({
          ts: new Date().toISOString(),
          level: "info",
          event: "fleet.down.requested",
          trigger: "signal",
          signal,
        });

        try {
          const status = await service.down({ all: true });
          for (const agent of status.agents) {
            emitAgentRuntimeLog(agent);
          }
          for (const session of status.sessions) {
            emitSessionLog(session);
          }
          emitJsonl({
            ts: new Date().toISOString(),
            level: "info",
            event: "fleet.down.completed",
            summary: status.summary,
            agentCount: status.agents.length,
          });
        } catch (error) {
          process.exitCode = 1;
          emitJsonl({
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

async function spawnDetachedSupervisorProcess(input: { gatekeepers: number; developers: number }): Promise<number | null> {
  const args = [
    process.argv[1],
    "up",
    "--gatekeepers",
    String(input.gatekeepers),
    "--developers",
    String(input.developers),
  ];
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
