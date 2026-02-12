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
  public startedThreads: Array<{ agentId: string }> = [];
  public startedTurns: Array<{ agentId: string; threadId: string; input: string }> = [];

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

  async startThread(agentId: string): Promise<{ threadId: string; lastNotificationAt: string }> {
    this.startedThreads.push({ agentId });
    return {
      threadId: `${agentId}-new-thread`,
      lastNotificationAt: "2026-01-01T00:00:02.000Z",
    };
  }

  async startTurn(inputAgentId: string, input: { threadId: string; input: string }): Promise<{ turnId: string; lastNotificationAt: string }> {
    this.startedTurns.push({ agentId: inputAgentId, threadId: input.threadId, input: input.input });
    return {
      turnId: `${inputAgentId}-event-turn`,
      lastNotificationAt: "2026-01-01T00:00:04.000Z",
    };
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
    expect(upStatus.agents).toHaveLength(3);
    expect(upStatus.agents.every((agent) => agent.status === "running")).toBe(true);
    expect(upStatus.sessions.every((session) => session.status === "ready")).toBe(true);
    expect(appServer.started).toEqual([
      expect.objectContaining({ agentId: "orchestrator-1", role: "Orchestrator", detached: false }),
      expect.objectContaining({ agentId: "gatekeeper-1", role: "Gatekeeper", detached: false }),
      expect.objectContaining({ agentId: "developer-1", role: "Developer", detached: false }),
    ]);
    expect(appServer.started.every((call) => call.prompt.length > 0)).toBe(true);

    const downStatus = await service.down({ all: true });
    expect(downStatus.summary).toBe("stopped");
    expect(downStatus.agents).toHaveLength(3);
    expect(downStatus.agents.every((agent) => agent.status === "stopped")).toBe(true);
    expect(downStatus.sessions).toHaveLength(3);
    expect(downStatus.sessions.every((session) => session.status === "disconnected")).toBe(true);
    expect(processManager.stopped.length).toBe(3);
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

    await service.up();
    await service.dispatchQueuedEvent({
      id: "evt-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      agentId: "gatekeeper-1",
      event: { type: "docs.update", paths: ["docs/spec.md"] },
      delivery: { promptFile: "gatekeeper/docs.event.md" },
      source: { command: "codefleet trigger docs.update" },
    });

    expect(appServer.startedThreads).toEqual([{ agentId: "gatekeeper-1" }]);
    expect(appServer.startedTurns).toHaveLength(1);
    expect(appServer.startedTurns[0]?.agentId).toBe("gatekeeper-1");
    expect(appServer.startedTurns[0]?.threadId).toBe("gatekeeper-1-new-thread");
    expect(appServer.startedTurns[0]?.input).toContain("You are the Gatekeeper processing a `docs.update` event.");
    expect(appServer.startedTurns[0]?.input).toContain("paths: docs/spec.md");

    const status = await service.status("Gatekeeper");
    expect(status.sessions[0]?.threadId).toBe("gatekeeper-1-new-thread");
    expect(status.sessions[0]?.activeTurnId).toBe("gatekeeper-1-event-turn");
  });
});
