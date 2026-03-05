import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

interface SupervisorConfigFleet {
  cwd: string;
}

interface SupervisorConfig {
  version?: number;
  fleets: SupervisorConfigFleet[];
}

interface SupervisorCommandOptions {
  loadConfig?: (configPath: string) => Promise<{ configPath: string; fleets: string[] }>;
  runFleetCommand?: (input: { cwd: string; args: string[]; streamOutput?: boolean }) => Promise<SupervisorFleetExecutionResult>;
}

interface SupervisorFleetExecutionResult {
  cwd: string;
  args: string[];
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface SupervisorExecutionSummary {
  total: number;
  succeeded: number;
  failed: number;
}

type FleetAggregateStatus = "running" | "stopped" | "degraded";

const DEFAULT_SUPERVISOR_CONFIG_FILE = "default.json";
const SUPERVISOR_CONFIG_DIRNAME = path.join("codefleet", "supervisor");
const ACTIVE_FOREGROUND_CHILDREN = new Set<ChildProcess>();

export function createSupervisorCommand(options: SupervisorCommandOptions = {}): Command {
  const loadConfig = options.loadConfig ?? loadSupervisorConfig;
  const runFleetCommand = options.runFleetCommand ?? runLocalCodefleetCommand;

  const cmd = new Command("supervisor");
  cmd.description("Manage multiple fleets from a shared config file");

  cmd
    .command("up")
    .description("Start all fleets from supervisor config")
    .option("--config <path>", "Path to supervisor config JSON")
    .option("-d, --detached", "Run fleet managers in background")
    .action(async (parsedOptions: { config?: string; detached?: boolean }) => {
      const { configPath, fleets } = await loadConfig(resolveSupervisorConfigPath(parsedOptions.config));
      const detached = Boolean(parsedOptions.detached);
      const upArgs = ["up", ...(detached ? ["--detached"] : []), "--skip-startup-preflight"];
      const shutdownState = { requested: false };
      const teardownSignalHandling = detached ? null : attachForegroundSignalHandlers(shutdownState);
      if (!detached) {
        console.error(`[supervisor] starting ${fleets.length} fleet(s) in foreground`);
      }
      try {
        const results = await executeAcrossFleets(fleets, (cwd) => {
          if (!detached) {
            console.error(`[supervisor] launching ${cwd}`);
          }
          return runFleetCommand({ cwd, args: upArgs, ...(detached ? {} : { streamOutput: true }) });
        });
        const output = {
          command: "up",
          configPath,
          summary: summarizeExecutions(results),
          fleets: sanitizeResults(results),
        };
        if (!detached && shutdownState.requested) {
          console.error("[supervisor] shutdown sequence completed");
        }
        console.log(JSON.stringify(output, null, 2));
        if (output.summary.failed > 0) {
          process.exitCode = 1;
        }
      } finally {
        teardownSignalHandling?.();
      }
    });

  cmd
    .command("down")
    .description("Stop all fleets from supervisor config")
    .option("--config <path>", "Path to supervisor config JSON")
    .action(async (parsedOptions: { config?: string }) => {
      const { configPath, fleets } = await loadConfig(resolveSupervisorConfigPath(parsedOptions.config));
      const results = await executeAcrossFleets(fleets, (cwd) => runFleetCommand({ cwd, args: ["down", "--all"] }));
      const output = {
        command: "down",
        configPath,
        summary: summarizeExecutions(results),
        fleets: sanitizeResults(results),
      };
      console.log(JSON.stringify(output, null, 2));
      if (output.summary.failed > 0) {
        process.exitCode = 1;
      }
    });

  cmd
    .command("status")
    .description("Collect status from all fleets in supervisor config")
    .option("--config <path>", "Path to supervisor config JSON")
    .option("--verbose", "Show full per-fleet status payload")
    .action(async (parsedOptions: { config?: string; verbose?: boolean }) => {
      const { configPath, fleets } = await loadConfig(resolveSupervisorConfigPath(parsedOptions.config));
      const results = await executeAcrossFleets(fleets, (cwd) => runFleetCommand({ cwd, args: ["status"] }));
      const executionSummary = summarizeExecutions(results);
      const summary = summarizeFleetAggregateStatus(results);
      const verbose = Boolean(parsedOptions.verbose);
      const output = verbose
        ? {
            command: "status",
            configPath,
            summary,
            executionSummary,
            fleets: sanitizeResults(results, { parseStatus: true }),
          }
        : {
            summary,
            fleets: compactStatusResults(results),
          };
      console.log(JSON.stringify(output, null, 2));
      if (executionSummary.failed > 0) {
        process.exitCode = 1;
      }
    });

  return cmd;
}

export function resolveSupervisorConfigPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath);
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  const configRoot =
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config");
  return path.join(configRoot, SUPERVISOR_CONFIG_DIRNAME, DEFAULT_SUPERVISOR_CONFIG_FILE);
}

export async function loadSupervisorConfig(configPath: string): Promise<{ configPath: string; fleets: string[] }> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const config = parseSupervisorConfig(parsed, configPath);

  const deduped = new Set<string>();
  const fleets: string[] = [];
  for (const fleet of config.fleets) {
    const absoluteCwd = path.resolve(fleet.cwd);
    if (deduped.has(absoluteCwd)) {
      continue;
    }
    deduped.add(absoluteCwd);

    const stats = await fs.stat(absoluteCwd).catch((error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`supervisor config fleet path does not exist: ${absoluteCwd}`);
      }
      throw error;
    });
    if (!stats.isDirectory()) {
      throw new Error(`supervisor config fleet path is not a directory: ${absoluteCwd}`);
    }
    fleets.push(absoluteCwd);
  }

  if (fleets.length === 0) {
    throw new Error(`supervisor config must include at least one fleet: ${configPath}`);
  }

  return { configPath, fleets };
}

function parseSupervisorConfig(input: unknown, configPath: string): SupervisorConfig {
  if (!input || typeof input !== "object") {
    throw new Error(`invalid supervisor config: expected object at ${configPath}`);
  }

  const payload = input as Record<string, unknown>;
  if (payload.version !== undefined && (typeof payload.version !== "number" || !Number.isFinite(payload.version))) {
    throw new Error(`invalid supervisor config: version must be a finite number at ${configPath}`);
  }

  if (!Array.isArray(payload.fleets)) {
    throw new Error(`invalid supervisor config: fleets must be an array at ${configPath}`);
  }

  const fleets: SupervisorConfigFleet[] = payload.fleets.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`invalid supervisor config: fleets[${index}] must be an object at ${configPath}`);
    }
    const record = entry as Record<string, unknown>;
    const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
    if (cwd.length === 0) {
      throw new Error(`invalid supervisor config: fleets[${index}].cwd must be a non-empty string at ${configPath}`);
    }
    return { cwd };
  });

  return {
    ...(payload.version !== undefined ? { version: payload.version as number } : {}),
    fleets,
  };
}

async function executeAcrossFleets(
  fleets: string[],
  run: (cwd: string) => Promise<SupervisorFleetExecutionResult>,
): Promise<SupervisorFleetExecutionResult[]> {
  // Fleetごとの失敗を隔離し、他ディレクトリの実行結果を常に返せるようにする。
  const executions = await Promise.allSettled(fleets.map((cwd) => run(cwd)));
  return executions.map((settled, index) => {
    if (settled.status === "fulfilled") {
      return settled.value;
    }

    return {
      cwd: fleets[index] ?? "",
      args: [],
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
    };
  });
}

function summarizeExecutions(results: SupervisorFleetExecutionResult[]): SupervisorExecutionSummary {
  const succeeded = results.filter((result) => result.ok).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}

function sanitizeResults(
  results: SupervisorFleetExecutionResult[],
  options: { parseStatus?: boolean } = {},
): Array<Record<string, unknown>> {
  return results.map((result) => {
    const base: Record<string, unknown> = {
      cwd: result.cwd,
      ok: result.ok,
      exitCode: result.exitCode,
      signal: result.signal,
      args: result.args,
    };

    if (options.parseStatus) {
      const parsedStatus = parseJsonIfPossible(result.stdout);
      if (parsedStatus !== null) {
        base.status = parsedStatus;
      }
    }

    if (!result.ok) {
      if (result.error) {
        base.error = result.error;
      }
      if (result.stderr.trim().length > 0) {
        base.stderr = result.stderr.trim();
      }
      if (result.stdout.trim().length > 0 && !options.parseStatus) {
        base.stdout = result.stdout.trim();
      }
    }

    return base;
  });
}

function compactStatusResults(
  results: SupervisorFleetExecutionResult[],
): Array<Record<string, unknown>> {
  return results.map((result) => {
    const parsedStatus = parseJsonIfPossible(result.stdout);
    const statusRecord = asRecord(parsedStatus);
    const summaryStatus = extractFleetSummaryStatus(statusRecord);
    const apiFleetStatusRecord = statusRecord ? asRecord(statusRecord.apiFleetStatus) : null;
    const summarySource = apiFleetStatusRecord ?? statusRecord;
    const statusReason = buildStatusReason(summarySource, summaryStatus);
    const nodes =
      apiFleetStatusRecord && apiFleetStatusRecord.nodes !== undefined
        ? apiFleetStatusRecord.nodes
        : apiFleetStatusRecord && apiFleetStatusRecord.endpointSnapshot !== undefined
          ? apiFleetStatusRecord.endpointSnapshot
        : statusRecord
          ? (statusRecord.nodes ?? statusRecord.endpointSnapshot ?? null)
          : null;
    const endpointRecord = asRecord(nodes);
    const projectId = endpointRecord && typeof endpointRecord.projectId === "string" ? endpointRecord.projectId : null;
    const selfRecord = endpointRecord ? asRecord(endpointRecord.self) : null;
    const normalizedSelf =
      selfRecord || projectId
        ? {
            ...(projectId ? { projectId } : {}),
            ...(selfRecord ?? {}),
          }
        : null;
    const peers = endpointRecord?.peers;
    const updatedAt = endpointRecord?.updatedAt;
    return {
      cwd: result.cwd,
      status: summaryStatus,
      status_reason: statusReason,
      ...(normalizedSelf ? { self: normalizedSelf } : {}),
      ...(peers !== undefined ? { peers } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  });
}

function summarizeFleetAggregateStatus(results: SupervisorFleetExecutionResult[]): FleetAggregateStatus {
  if (results.length === 0) {
    return "stopped";
  }
  const statuses = results.map((result) => {
    const parsedStatus = parseJsonIfPossible(result.stdout);
    return extractFleetSummaryStatus(asRecord(parsedStatus));
  });
  if (statuses.every((status) => status === "running")) {
    return "running";
  }
  if (statuses.every((status) => status === "stopped")) {
    return "stopped";
  }
  return "degraded";
}

function extractFleetSummaryStatus(statusRecord: Record<string, unknown> | null): FleetAggregateStatus | null {
  if (!statusRecord) {
    return null;
  }
  const apiFleetStatusRecord = asRecord(statusRecord.apiFleetStatus);
  const summarySource = apiFleetStatusRecord ?? statusRecord;
  const summaryStatus = summarySource.summary;
  if (summaryStatus === "running" || summaryStatus === "stopped" || summaryStatus === "degraded") {
    return summaryStatus;
  }
  return null;
}

function buildStatusReason(statusRecord: Record<string, unknown> | null, summaryStatus: string | null): string | null {
  if (!statusRecord || !summaryStatus) {
    return null;
  }

  const agents = Array.isArray(statusRecord.agents) ? statusRecord.agents : [];
  const sessions = Array.isArray(statusRecord.sessions) ? statusRecord.sessions : [];
  const apiServer = asRecord(statusRecord.apiServer);
  const apiState = typeof apiServer?.state === "string" ? apiServer.state : null;

  if (summaryStatus === "running") {
    return "all agents are running, sessions are ready, and api server is running";
  }
  if (summaryStatus === "stopped") {
    return "all agents are stopped and api server is not running";
  }

  const nonRunningAgents = agents.filter((agent) => asRecord(agent)?.status !== "running").length;
  const nonReadySessions = sessions.filter((session) => asRecord(session)?.status !== "ready").length;
  const reasons: string[] = [];
  if (nonRunningAgents > 0) {
    reasons.push(`${nonRunningAgents}/${agents.length} agents are not running`);
  }
  if (nonReadySessions > 0) {
    reasons.push(`${nonReadySessions}/${sessions.length} sessions are not ready`);
  }
  if (apiState && apiState !== "running") {
    reasons.push(`api server state is ${apiState}`);
  }
  if (reasons.length === 0) {
    return "components are in mixed states";
  }
  return reasons.join("; ");
}

async function runLocalCodefleetCommand(input: {
  cwd: string;
  args: string[];
  streamOutput?: boolean;
}): Promise<SupervisorFleetExecutionResult> {
  // 現在のCLIエントリポイントを再利用し、配布版(dist)と開発実行(tsx)の両方で
  // 同じ `codefleet` 実体へ委譲する。
  // 開発環境では wrapper が `--import <tsx-loader>` を付けて `src/cli/codefleet.ts` を
  // 起動するため、execArgv を引き継がないと `.ts` を直接実行して失敗する。
  const commandArgs = [...process.execArgv, process.argv[1] ?? "", ...input.args].filter((arg) => arg.length > 0);
  if (commandArgs.length === 0) {
    throw new Error("failed to resolve codefleet entrypoint for supervisor");
  }

  const child = spawn(process.execPath, commandArgs, {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (input.streamOutput) {
    ACTIVE_FOREGROUND_CHILDREN.add(child);
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutRelay = createLinePrefixRelay(process.stdout, `[${path.basename(input.cwd) || input.cwd}] `);
  const stderrRelay = createLinePrefixRelay(process.stderr, `[${path.basename(input.cwd) || input.cwd}] `);

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdoutChunks.push(text);
    if (input.streamOutput) {
      stdoutRelay.write(text);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrChunks.push(text);
    if (input.streamOutput) {
      stderrRelay.write(text);
    }
  });

  const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
    child.once("error", (error) => {
      ACTIVE_FOREGROUND_CHILDREN.delete(child);
      resolve({
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.once("exit", (code, signal) => {
      ACTIVE_FOREGROUND_CHILDREN.delete(child);
      if (input.streamOutput) {
        console.error(`[supervisor] fleet process exited cwd=${input.cwd} code=${String(code)} signal=${String(signal)}`);
      }
      resolve({ exitCode: code, signal });
    });
  });

  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");
  if (input.streamOutput) {
    stdoutRelay.flush();
    stderrRelay.flush();
  }
  const ok = !outcome.error && outcome.exitCode === 0;

  return {
    cwd: input.cwd,
    args: input.args,
    ok,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout,
    stderr,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

function parseJsonIfPossible(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function createLinePrefixRelay(stream: NodeJS.WriteStream, prefix: string): { write: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  return {
    write(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        stream.write(`${prefix}${line}\n`);
      }
    },
    flush() {
      if (buffer.length > 0) {
        stream.write(`${prefix}${buffer}\n`);
        buffer = "";
      }
    },
  };
}

function attachForegroundSignalHandlers(shutdownState: { requested: boolean }): () => void {
  const watchedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let forceExitArmed = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!shutdownState.requested) {
      shutdownState.requested = true;
      console.error(`[supervisor] received ${signal}; requesting graceful shutdown`);
      const children = [...ACTIVE_FOREGROUND_CHILDREN].filter((child) => child.exitCode === null && child.signalCode === null);
      console.error(`[supervisor] forwarding ${signal} to ${children.length} fleet process(es)`);
      for (const child of children) {
        try {
          child.kill(signal);
        } catch {
          // Best-effort forwarding only.
        }
      }
      forceExitArmed = true;
      return;
    }

    if (forceExitArmed) {
      console.error(`[supervisor] received ${signal} again; forcing exit`);
      process.exit(signal === "SIGTERM" ? 143 : 130);
    }
  };

  for (const signal of watchedSignals) {
    process.on(signal, onSignal);
  }

  return () => {
    for (const signal of watchedSignals) {
      process.removeListener(signal, onSignal);
    }
  };
}
