import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FleetService } from "../src/domain/fleet/fleet-service.js";
import type { FleetApiServerLifecycle, FleetApiServerStatus } from "../src/api/mcp/fleet-api-server-lifecycle.js";
import type {
  ExecuteRoleAgentInput,
  ExecuteRoleAgentResult,
  PrepareRoleAgentInput,
  PrepareRoleAgentResult,
  RoleAgentRuntime,
} from "../src/domain/fleet/role-agent-runtime.js";
import type { AgentSession } from "../src/domain/agent-session-model.js";
import type { AgentRole } from "../src/domain/roles-model.js";
import type { FleetProcessStartResult } from "../src/infra/process/fleet-process-manager.js";
import type { HookCommandRunner } from "../src/infra/process/hook-command-runner.js";

class FakeProcessManager {
  public stopped: Array<number | null> = [];

  async start(): Promise<FleetProcessStartResult> {
    return {
      pid: 12345,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async stop(pid: number | null): Promise<void> {
    this.stopped.push(pid);
  }
}

class FakeAppServerClient {
  public started: Array<{
    agentId: string;
    role: AgentRole;
    prompt: string;
    detached: boolean;
    playwrightServerUrl?: string;
    codexConfig?: Record<string, unknown>;
  }> = [];
  public startedThreads: Array<{ agentId: string; baseInstructions?: string; codexConfig?: Record<string, unknown> }> = [];
  public startedTurns: Array<{ agentId: string; threadId: string; input: Array<{ type: "text"; text: string }> }> = [];
  public completedTurns: Array<{ agentId: string; threadId: string; turnId: string }> = [];
  public shutdowns: string[] = [];

  async startAgent(input: {
    agentId: string;
    role: AgentRole;
    prompt: string;
    cwd: string;
    detached: boolean;
    playwrightServerUrl?: string;
    codexConfig?: Record<string, unknown>;
  }): Promise<FleetProcessStartResult> {
    this.started.push({
      agentId: input.agentId,
      role: input.role,
      prompt: input.prompt,
      detached: input.detached,
      playwrightServerUrl: input.playwrightServerUrl,
      codexConfig: input.codexConfig,
    });
    return {
      pid: 12345,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async handshake(agentId: string): Promise<{ threadId: string | null; activeTurnId: string | null; lastNotificationAt: string }> {
    return {
      threadId: `${agentId}-thread`,
      activeTurnId: `${agentId}-turn`,
      lastNotificationAt: "2026-01-01T00:00:01.000Z",
    };
  }

  async startThread(
    agentId: string,
    input: { baseInstructions?: string; codexConfig?: Record<string, unknown> } = {},
  ): Promise<{ threadId: string; lastNotificationAt: string }> {
    this.startedThreads.push({ agentId, baseInstructions: input.baseInstructions, codexConfig: input.codexConfig });
    return {
      threadId: `${agentId}-new-thread`,
      lastNotificationAt: "2026-01-01T00:00:02.000Z",
    };
  }

  async startTurn(
    inputAgentId: string,
    input: { threadId: string; input: Array<{ type: "text"; text: string }> },
  ): Promise<{ turnId: string; lastNotificationAt: string }> {
    this.startedTurns.push({ agentId: inputAgentId, threadId: input.threadId, input: input.input });
    return {
      turnId: `${inputAgentId}-event-turn`,
      lastNotificationAt: "2026-01-01T00:00:04.000Z",
    };
  }

  async waitForTurnCompletion(agentId: string, threadId: string, turnId: string): Promise<void> {
    this.completedTurns.push({ agentId, threadId, turnId });
  }

  async shutdownAgent(agentId: string): Promise<void> {
    this.shutdowns.push(agentId);
  }
}

class FailingTurnAppServerClient extends FakeAppServerClient {
  override async startTurn(
    _inputAgentId: string,
    _input: { threadId: string; input: Array<{ type: "text"; text: string }> },
  ): Promise<{ turnId: string; lastNotificationAt: string }> {
    throw new Error("injected startTurn failure");
  }
}

class FakeHookCommandRunner implements HookCommandRunner {
  public executed: Array<{ command: string; phase: string | undefined; role: string | undefined }> = [];

  async run(command: string, options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
    void options.cwd;
    this.executed.push({
      command,
      phase: options.env.CODEFLEET_HOOK_PHASE,
      role: options.env.CODEFLEET_HOOK_ROLE,
    });
  }
}

class FakeRoleAgentRuntime implements RoleAgentRuntime {
  readonly provider = "codex-app-server" as const;
  public prepared: PrepareRoleAgentInput[] = [];
  public executed: ExecuteRoleAgentInput[] = [];
  public shutdowns: string[] = [];

  async prepareAgent(input: PrepareRoleAgentInput): Promise<PrepareRoleAgentResult> {
    this.prepared.push(input);
    return {
      provider: this.provider,
      pid: 4444,
      startedAt: "2026-01-01T00:00:00.000Z",
      session: {
        conversationId: `${input.agentId}-prepared-thread`,
        activeInvocationId: `${input.agentId}-prepared-turn`,
        lastActivityAt: "2026-01-01T00:00:01.000Z",
      },
    };
  }

  async execute(input: ExecuteRoleAgentInput): Promise<ExecuteRoleAgentResult> {
    this.executed.push(input);
    return {
      provider: this.provider,
      session: {
        conversationId: `${input.agentId}-runtime-thread`,
        activeInvocationId: `${input.agentId}-runtime-turn`,
        lastActivityAt: "2026-01-01T00:00:02.000Z",
      },
    };
  }

  async shutdownAgent(agentId: string): Promise<void> {
    this.shutdowns.push(agentId);
  }
}

class FakeApiServerLifecycle implements FleetApiServerLifecycle {
  public started = 0;
  public stopped = 0;
  public discovered = [] as Array<{
    instanceId: string;
    pid: number;
    projectId: string;
    host: string;
    port: number;
    startedAt: string;
    lastHeartbeat: string;
  }>;
  private state: FleetApiServerStatus = {
    state: "stopped",
    host: "127.0.0.1",
    port: 3290,
    startedAt: null,
  };

  async start(): Promise<FleetApiServerStatus> {
    this.started += 1;
    this.state = {
      state: "running",
      host: "127.0.0.1",
      port: 3290,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    return this.state;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    this.state = {
      state: "stopped",
      host: "127.0.0.1",
      port: 3290,
      startedAt: null,
    };
  }

  status(): FleetApiServerStatus {
    return this.state;
  }

  async discover() {
    return this.discovered;
  }
}

describe("FleetService", () => {
  it("raises a diagnostic error when API server startup fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");

    const failingLifecycle: FleetApiServerLifecycle = {
      async start() {
        throw new Error("EADDRINUSE 127.0.0.1:3290");
      },
      async stop() {
        // no-op
      },
      status() {
        return {
          state: "error",
          host: "127.0.0.1",
          port: 3290,
          startedAt: null,
          lastError: "EADDRINUSE 127.0.0.1:3290",
        };
      },
      async discover() {
        return [];
      },
    };

    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
      undefined,
      undefined,
      failingLifecycle,
    );

    await expect(service.up()).rejects.toMatchObject<Partial<Error>>({
      message: "failed to start fleet API server: EADDRINUSE 127.0.0.1:3290",
    });
  });

  it("starts and stops MCP API server with fleet lifecycle", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");

    const apiLifecycle = new FakeApiServerLifecycle();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
      undefined,
      undefined,
      apiLifecycle,
    );

    const upStatus = await service.up();
    expect(apiLifecycle.started).toBe(1);
    expect(upStatus.apiServer?.state).toBe("running");
    expect(upStatus.discoveredApiServers).toEqual([]);

    apiLifecycle.discovered = [
      {
        instanceId: "cf_peer",
        pid: 43210,
        projectId: "acme/codefleet",
        host: "127.0.0.1",
        port: 3390,
        startedAt: "2026-01-01T00:00:00.000Z",
        lastHeartbeat: "2026-01-01T00:00:05.000Z",
      },
    ];
    const statusWithPeer = await service.status();
    expect(statusWithPeer.discoveredApiServers).toEqual(apiLifecycle.discovered);

    const downStatus = await service.down({ all: true });
    expect(apiLifecycle.stopped).toBe(1);
    expect(downStatus.apiServer?.state).toBe("stopped");
  });

  it("starts fixed roles with default counts and transitions runtime/session state on up and down", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");

    const processManager = new FakeProcessManager();
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      processManager as never,
      appServer as never,
    );

    const upStatus = await service.up();
    expect(upStatus.summary).toBe("running");
    expect(upStatus.agents).toHaveLength(6);
    expect(upStatus.agents.every((agent) => agent.status === "running")).toBe(true);
    expect(upStatus.agents.every((agent) => agent.provider === "codex-app-server")).toBe(true);
    expect(upStatus.sessions.every((session) => session.status === "ready")).toBe(true);
    expect(appServer.started).toEqual([
      expect.objectContaining({ agentId: "orchestrator-1", role: "Orchestrator", detached: false }),
      expect.objectContaining({ agentId: "curator-1", role: "Curator", detached: false }),
      expect.objectContaining({ agentId: "gatekeeper-1", role: "Gatekeeper", detached: false }),
      expect.objectContaining({ agentId: "developer-1", role: "Developer", detached: false }),
      expect.objectContaining({ agentId: "polisher-1", role: "Polisher", detached: false }),
      expect.objectContaining({ agentId: "reviewer-1", role: "Reviewer", detached: false }),
    ]);
    expect(appServer.started.every((call) => call.prompt.length > 0)).toBe(true);

    const downStatus = await service.down({ all: true });
    expect(downStatus.summary).toBe("stopped");
    expect(downStatus.agents).toHaveLength(6);
    expect(downStatus.agents.every((agent) => agent.status === "stopped")).toBe(true);
    expect(downStatus.sessions).toHaveLength(6);
    expect(downStatus.sessions.every((session) => session.status === "disconnected")).toBe(true);
    expect(processManager.stopped.length).toBe(6);
    expect(processManager.stopped).toEqual([12345, 12345, 12345, 12345, 12345, 12345]);
    expect(appServer.shutdowns.sort()).toEqual([
      "curator-1",
      "developer-1",
      "gatekeeper-1",
      "orchestrator-1",
      "polisher-1",
      "reviewer-1",
    ]);
  });

  it("uses the injected role runtime boundary instead of app-server RPC methods directly", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");

    const runtime = new FakeRoleAgentRuntime();
    const appServer = new FakeAppServerClient();
    const processManager = new FakeProcessManager();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      processManager as never,
      appServer as never,
      undefined,
      undefined,
      undefined,
      runtime,
    );

    await service.up({ reviewers: 0, polishers: 0, developers: 0, gatekeepers: 0 });
    expect(runtime.prepared.map((entry) => entry.agentId)).toEqual(["orchestrator-1", "curator-1"]);
    expect(appServer.started).toEqual([]);

    await service.dispatchAgentEvent({
      agentId: "curator-1",
      agentRole: "Curator",
      event: { type: "docs.update", paths: ["docs/spec.md"] },
    });
    expect(runtime.executed).toHaveLength(1);
    expect(runtime.executed[0]).toMatchObject({
      agentId: "curator-1",
      role: "Curator",
      responseLanguage: undefined,
    });
    expect(runtime.executed[0]?.prompt).toContain("docs/spec.md");
    expect(appServer.startedThreads).toEqual([]);
    expect(appServer.startedTurns).toEqual([]);

    const status = await service.status("Curator");
    expect(status.sessions[0]).toMatchObject<Partial<AgentSession>>({
      provider: "codex-app-server",
      conversationId: "curator-1-runtime-thread",
      activeInvocationId: "curator-1-runtime-turn",
    });

    await service.down({ all: true });
    expect(runtime.shutdowns.sort()).toEqual(["curator-1", "orchestrator-1"]);
    expect(processManager.stopped).toEqual([4444, 4444]);
    expect(appServer.shutdowns).toEqual([]);
  });

  it("uses role counts, filters by role and tails logs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");

    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, "developer-2.log"), "line1\nline2\nline3\n", "utf8");

    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
    );

    await service.up({ gatekeepers: 0, developers: 2, detached: true });
    const status = await service.status("Developer");
    expect(status.agents).toHaveLength(2);
    expect(status.agents[0]?.id).toBe("developer-1");
    expect(status.agents[1]?.id).toBe("developer-2");

    const logs = await service.logs({ role: "Developer", tail: 2 });
    expect(logs).toContain("[developer-2]");
    expect(logs).not.toContain("line1");
    expect(logs).toContain("line2");
    expect(logs).toContain("line3");
  });

  it("starts a new thread for curator docs.update and uses event prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up({ lang: "日本語" });
    const emittedEvent = await service.dispatchQueuedEvent({
      id: "evt-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      agentId: "curator-1",
      agentRole: "Curator",
      event: { type: "docs.update", paths: ["docs/spec.md"] },
      source: { command: "codefleet trigger docs.update" },
    });
    expect(emittedEvent).toEqual({
      type: "source-brief.update",
      briefPath: ".codefleet/data/source-brief/latest.md",
      sourcePaths: ["docs/spec.md"],
    });

    expect(appServer.startedThreads).toEqual([
      { agentId: "curator-1", baseInstructions: "All responses must be in 日本語.", codexConfig: {} },
    ]);
    expect(appServer.startedTurns).toHaveLength(1);
    expect(appServer.startedTurns[0]?.agentId).toBe("curator-1");
    expect(appServer.startedTurns[0]?.threadId).toBe("curator-1-new-thread");
    expect(appServer.startedTurns[0]?.input).toHaveLength(1);
    expect(appServer.startedTurns[0]?.input[0]?.type).toBe("text");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Please take on the role of Curator for this task.");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Updated source documents (from docs.update paths):");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("docs/spec.md");
    expect(appServer.completedTurns).toEqual([
      { agentId: "curator-1", threadId: "curator-1-new-thread", turnId: "curator-1-event-turn" },
    ]);

    const status = await service.status("Curator");
    expect(status.sessions[0]?.conversationId).toBe("curator-1-new-thread");
    expect(status.sessions[0]?.activeInvocationId).toBe("curator-1-event-turn");
  });

  it("uses lang from .codefleet/config.json when up input omits lang", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const configPath = path.join(tempDir, ".codefleet/config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          lang: "日本語",
          docsRepository: "https://example.com/spec.git",
          hooks: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    await service.dispatchQueuedEvent({
      id: "evt-lang-config-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      agentId: "curator-1",
      agentRole: "Curator",
      event: { type: "docs.update", paths: ["docs/spec.md"] },
      source: { command: "codefleet trigger docs.update" },
    });

    expect(appServer.startedThreads).toEqual([
      { agentId: "curator-1", baseInstructions: "All responses must be in 日本語.", codexConfig: {} },
    ]);
  });

  it("passes .codefleet/config.json codex settings into AppServer startup and thread creation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const configPath = path.join(tempDir, ".codefleet/config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          lang: "ja",
          docsRepository: "https://example.com/spec.git",
          codex: {
            model: "gpt-5-mini-codex",
            model_reasoning_effort: "medium",
          },
          hooks: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    expect(appServer.started[0]?.codexConfig).toEqual({
      model: "gpt-5-mini-codex",
      model_reasoning_effort: "medium",
    });

    await service.dispatchAgentEvent({
      agentId: "curator-1",
      agentRole: "Curator",
      event: { type: "docs.update", paths: ["docs/spec.md"] },
    });

    expect(appServer.startedThreads[0]?.codexConfig).toEqual({
      model: "gpt-5-mini-codex",
      model_reasoning_effort: "medium",
    });
  });

  it("resolves role-specific agentRuntime config before legacy codex defaults", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const configPath = path.join(tempDir, ".codefleet/config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          lang: "ja",
          docsRepository: "https://example.com/spec.git",
          agentRuntime: {
            default: {
              provider: "codex-app-server",
              config: { model: "gpt-default-codex" },
            },
            roles: {
              Curator: {
                provider: "codex-app-server",
                config: { model: "gpt-curator-codex", model_reasoning_effort: "low" },
              },
            },
          },
          codex: {
            model: "legacy-codex-should-not-win",
          },
          hooks: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up({ gatekeepers: 0, developers: 1, polishers: 0, reviewers: 0 });
    expect(appServer.started.find((entry) => entry.agentId === "curator-1")?.codexConfig).toEqual({
      model: "gpt-curator-codex",
      model_reasoning_effort: "low",
    });
    expect(appServer.started.find((entry) => entry.agentId === "developer-1")?.codexConfig).toEqual({
      model: "gpt-default-codex",
    });

    await service.dispatchAgentEvent({
      agentId: "curator-1",
      agentRole: "Curator",
      event: { type: "docs.update", paths: ["docs/spec.md"] },
    });

    expect(appServer.startedThreads[0]?.codexConfig).toEqual({
      model: "gpt-curator-codex",
      model_reasoning_effort: "low",
    });
    expect((await service.status("Curator")).agents[0]?.provider).toBe("codex-app-server");
  });

  it("migrates legacy runtime and app-server session state into provider-neutral models", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "agents.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          agents: [
            {
              id: "curator-1",
              role: "Curator",
              status: "running",
              pid: 12345,
              cwd: "/workspace",
              startedAt: "2026-01-01T00:00:00.000Z",
              lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(runtimeDir, "app-server-sessions.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          sessions: [
            {
              agentId: "curator-1",
              status: "ready",
              initialized: true,
              threadId: "legacy-thread",
              activeTurnId: "legacy-turn",
              lastNotificationAt: "2026-01-01T00:00:02.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
    );

    const status = await service.status("Curator");
    expect(status.agents[0]).toMatchObject({
      id: "curator-1",
      provider: "codex-app-server",
    });
    expect(status.sessions[0]).toMatchObject<Partial<AgentSession>>({
      agentId: "curator-1",
      provider: "codex-app-server",
      conversationId: "legacy-thread",
      activeInvocationId: "legacy-turn",
      lastActivityAt: "2026-01-01T00:00:02.000Z",
    });

    const migratedSessions = JSON.parse(
      await fs.readFile(path.join(runtimeDir, "agent-sessions.json"), "utf8"),
    ) as { sessions: AgentSession[] };
    expect(migratedSessions.sessions[0]?.conversationId).toBe("legacy-thread");
  });

  it("emits acceptance-test.update after gatekeeper handles source-brief.update", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "gatekeeper-1",
      agentRole: "Gatekeeper",
      event: {
        type: "source-brief.update",
        briefPath: ".codefleet/data/source-brief/latest.md",
        sourcePaths: ["docs/spec.md"],
      },
    });

    expect(emittedEvent).toEqual({ type: "acceptance-test.update" });
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Primary source brief:");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain(".codefleet/data/source-brief/latest.md");
  });

  it("emits backlog.epic.polish.ready after developer implementation prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "developer-1",
      agentRole: "Developer",
      event: { type: "backlog.epic.ready", epicId: "E-123" },
    });
    expect(emittedEvent).toEqual({ type: "backlog.epic.polish.ready", epicId: "E-123" });
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Epic ID to implement now: E-123");
  });

  it("emits backlog.epic.review.ready after polisher polishing prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "polisher-1",
      agentRole: "Polisher",
      event: { type: "backlog.epic.polish.ready", epicId: "E-333" },
    });

    expect(emittedEvent).toEqual({ type: "backlog.epic.review.ready", epicId: "E-333" });
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Epic ID to polish now: E-333");
  });

  it("starts reviewer review prompt for backlog.epic.review.ready", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up({ playwrightServerUrl: "http://127.0.0.1:9333" });
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "reviewer-1",
      agentRole: "Reviewer",
      event: { type: "backlog.epic.review.ready", epicId: "E-456" },
    });

    expect(emittedEvent).toBeNull();
    expect(appServer.started.find((entry) => entry.agentId === "reviewer-1")?.playwrightServerUrl).toBe(
      "http://127.0.0.1:9333",
    );
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Epic ID to review now: E-456");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Playwright remote server endpoint: http://127.0.0.1:9333");
  });

  it("runs gatekeeper acceptance-test.run prompt for acceptance-test.required without follow-up emit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "gatekeeper-1",
      agentRole: "Gatekeeper",
      event: { type: "acceptance-test.required" },
    });

    expect(emittedEvent).toBeNull();
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Gatekeeper must create dedicated acceptance-test scripts");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("codefleet-gatekeeper-tools --help");
  });

  it("emits backlog.update after orchestrator handles acceptance-test.update", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "orchestrator-1",
      agentRole: "Orchestrator",
      event: { type: "acceptance-test.update" },
    });

    expect(emittedEvent).toEqual({ type: "backlog.update" });
  });

  it("runs orchestrator feedback-note.create prompt with event.path and no follow-up emit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const appServer = new FakeAppServerClient();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      appServer as never,
    );

    await service.up();
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "orchestrator-1",
      agentRole: "Orchestrator",
      event: { type: "feedback-note.create", path: ".codefleet/data/feedback-notes/01HXTEST0000000000000000.md" },
    });

    expect(emittedEvent).toBeNull();
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain(
      "Feedback note path: .codefleet/data/feedback-notes/01HXTEST0000000000000000.md",
    );
  });

  it("runs before_start and after_complete hooks for the role", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const configPath = path.join(tempDir, ".codefleet/config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          lang: "ja",
          docsRepository: "https://example.com/spec.git",
          hooks: {
            Developer: {
              before_start: "echo before",
              after_complete: "echo complete",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const hookRunner = new FakeHookCommandRunner();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
      undefined,
      hookRunner,
    );
    await service.up();

    await service.dispatchAgentEvent({
      agentId: "developer-1",
      agentRole: "Developer",
      event: { type: "backlog.epic.ready", epicId: "E-321" },
    });

    expect(hookRunner.executed).toEqual([
      { command: "echo before", phase: "before_start", role: "Developer" },
      { command: "echo complete", phase: "after_complete", role: "Developer" },
    ]);
  });

  it("reads hooks from .codefleet/config.json hooks field", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const configPath = path.join(tempDir, ".codefleet/config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          lang: "ja",
          docsRepository: "https://example.com/spec.git",
          hooks: {
            Developer: {
              before_start: "echo before-config",
              after_complete: "echo complete-config",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const hookRunner = new FakeHookCommandRunner();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
      undefined,
      hookRunner,
    );
    await service.up();

    await service.dispatchAgentEvent({
      agentId: "developer-1",
      agentRole: "Developer",
      event: { type: "backlog.epic.ready", epicId: "E-999" },
    });

    expect(hookRunner.executed).toEqual([
      { command: "echo before-config", phase: "before_start", role: "Developer" },
      { command: "echo complete-config", phase: "after_complete", role: "Developer" },
    ]);
  });

  it("runs after_fail hook when role dispatch fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const configPath = path.join(tempDir, ".codefleet/config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          lang: "ja",
          docsRepository: "https://example.com/spec.git",
          hooks: {
            Developer: {
              before_start: "echo before",
              after_fail: "echo failed",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const hookRunner = new FakeHookCommandRunner();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FailingTurnAppServerClient() as never,
      undefined,
      hookRunner,
    );
    await service.up();

    await expect(
      service.dispatchAgentEvent({
        agentId: "developer-1",
        agentRole: "Developer",
        event: { type: "backlog.epic.ready", epicId: "E-654" },
      }),
    ).rejects.toThrow(/injected startTurn failure/u);

    expect(hookRunner.executed).toEqual([
      { command: "echo before", phase: "before_start", role: "Developer" },
      { command: "echo failed", phase: "after_fail", role: "Developer" },
    ]);
  });

  it("logs hook command before execution", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-fleet-"));
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const runtimeDir = path.join(tempDir, ".codefleet/runtime");
    const logDir = path.join(tempDir, ".codefleet/logs/agents");
    const configPath = path.join(tempDir, ".codefleet/config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          lang: "ja",
          docsRepository: "https://example.com/spec.git",
          hooks: {
            Developer: {
              before_start: "echo hook-log",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const hookRunner = new FakeHookCommandRunner();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
      undefined,
      hookRunner,
    );
    await service.up();

    await service.dispatchAgentEvent({
      agentId: "developer-1",
      agentRole: "Developer",
      event: { type: "backlog.epic.ready", epicId: "E-777" },
    });

    expect(logSpy).toHaveBeenCalledWith("[codefleet:hook] role=Developer phase=before_start command=echo hook-log");
    logSpy.mockRestore();
  });
});
