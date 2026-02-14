import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FleetService } from "../src/domain/agents/fleet-service.js";
import type { AgentRole } from "../src/domain/roles-model.js";
import type { AppServerSession } from "../src/domain/app-server-session-model.js";
import type { FleetProcessStartResult } from "../src/infra/process/fleet-process-manager.js";

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
  public started: Array<{ agentId: string; role: AgentRole; prompt: string; detached: boolean }> = [];
  public startedThreads: Array<{ agentId: string; baseInstructions?: string }> = [];
  public startedTurns: Array<{ agentId: string; threadId: string; input: Array<{ type: "text"; text: string }> }> = [];
  public completedTurns: Array<{ agentId: string; threadId: string; turnId: string }> = [];

  async startAgent(input: {
    agentId: string;
    role: AgentRole;
    prompt: string;
    cwd: string;
    detached: boolean;
  }): Promise<FleetProcessStartResult> {
    this.started.push({ agentId: input.agentId, role: input.role, prompt: input.prompt, detached: input.detached });
    return {
      pid: 12345,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async handshake(agentId: string): Promise<Pick<AppServerSession, "threadId" | "activeTurnId" | "lastNotificationAt">> {
    return {
      threadId: `${agentId}-thread`,
      activeTurnId: `${agentId}-turn`,
      lastNotificationAt: "2026-01-01T00:00:01.000Z",
    };
  }

  async startThread(
    agentId: string,
    input: { baseInstructions?: string } = {},
  ): Promise<{ threadId: string; lastNotificationAt: string }> {
    this.startedThreads.push({ agentId, baseInstructions: input.baseInstructions });
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
}

describe("FleetService", () => {
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
    expect(upStatus.agents).toHaveLength(4);
    expect(upStatus.agents.every((agent) => agent.status === "running")).toBe(true);
    expect(upStatus.sessions.every((session) => session.status === "ready")).toBe(true);
    expect(appServer.started).toEqual([
      expect.objectContaining({ agentId: "orchestrator-1", role: "Orchestrator", detached: false }),
      expect.objectContaining({ agentId: "gatekeeper-1", role: "Gatekeeper", detached: false }),
      expect.objectContaining({ agentId: "developer-1", role: "Developer", detached: false }),
      expect.objectContaining({ agentId: "reviewer-1", role: "Reviewer", detached: false }),
    ]);
    expect(appServer.started.every((call) => call.prompt.length > 0)).toBe(true);

    const downStatus = await service.down({ all: true });
    expect(downStatus.summary).toBe("stopped");
    expect(downStatus.agents).toHaveLength(4);
    expect(downStatus.agents.every((agent) => agent.status === "stopped")).toBe(true);
    expect(downStatus.sessions).toHaveLength(4);
    expect(downStatus.sessions.every((session) => session.status === "disconnected")).toBe(true);
    expect(processManager.stopped.length).toBe(4);
    expect(processManager.stopped).toEqual([12345, 12345, 12345, 12345]);
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

  it("starts a new thread for gatekeeper docs.update and uses event prompt", async () => {
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
      agentId: "gatekeeper-1",
      agentRole: "Gatekeeper",
      event: { type: "docs.update", paths: ["docs/spec.md"] },
      source: { command: "codefleet trigger docs.update" },
    });
    expect(emittedEvent).toEqual({
      type: "acceptance-test.update",
    });

    expect(appServer.startedThreads).toEqual([
      { agentId: "gatekeeper-1", baseInstructions: "All responses must be in 日本語." },
    ]);
    expect(appServer.startedTurns).toHaveLength(1);
    expect(appServer.startedTurns[0]?.agentId).toBe("gatekeeper-1");
    expect(appServer.startedTurns[0]?.threadId).toBe("gatekeeper-1-new-thread");
    expect(appServer.startedTurns[0]?.input).toHaveLength(1);
    expect(appServer.startedTurns[0]?.input[0]?.type).toBe("text");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Please take on the role of Gatekeeper for this task.");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Trigger event: docs.update");
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("acceptance-test.update.md");
    expect(appServer.completedTurns).toEqual([
      { agentId: "gatekeeper-1", threadId: "gatekeeper-1-new-thread", turnId: "gatekeeper-1-event-turn" },
    ]);

    const status = await service.status("Gatekeeper");
    expect(status.sessions[0]?.threadId).toBe("gatekeeper-1-new-thread");
    expect(status.sessions[0]?.activeTurnId).toBe("gatekeeper-1-event-turn");
  });

  it("emits backlog.epic.review.ready after developer implementation prompt", async () => {
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
    expect(emittedEvent).toEqual({ type: "backlog.epic.review.ready", epicId: "E-123" });
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Epic ID to implement now: E-123");
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

    await service.up();
    const emittedEvent = await service.dispatchAgentEvent({
      agentId: "reviewer-1",
      agentRole: "Reviewer",
      event: { type: "backlog.epic.review.ready", epicId: "E-456" },
    });

    expect(emittedEvent).toBeNull();
    expect(appServer.startedTurns[0]?.input[0]?.text).toContain("Epic ID to review now: E-456");
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
});
