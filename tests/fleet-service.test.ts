import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FleetService } from "../src/domain/agents/fleet-service.js";
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
  async handshake(agentId: string): Promise<Pick<AppServerSession, "threadId" | "activeTurnId" | "lastNotificationAt">> {
    return {
      threadId: `${agentId}-thread`,
      activeTurnId: `${agentId}-turn`,
      lastNotificationAt: "2026-01-01T00:00:01.000Z",
    };
  }
}

describe("FleetService", () => {
  it("transitions runtime/session state on up and down", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-fleet-"));
    const rolesPath = path.join(tempDir, ".buildfleet/roles.json");
    const runtimeDir = path.join(tempDir, ".buildfleet/runtime");
    const logDir = path.join(tempDir, ".buildfleet/logs/agents");

    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(
      rolesPath,
      JSON.stringify(
        { agents: [{ id: "pm-agent", role: "Orchestrator" }, { id: "dev-agent", role: "Developer" }] },
        null,
        2,
      ),
      "utf8",
    );

    const processManager = new FakeProcessManager();
    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      processManager as never,
      new FakeAppServerClient() as never,
    );

    const upStatus = await service.up();
    expect(upStatus.summary).toBe("running");
    expect(upStatus.agents.every((agent) => agent.status === "running")).toBe(true);
    expect(upStatus.sessions.every((session) => session.status === "ready")).toBe(true);

    const downStatus = await service.down({ all: true });
    expect(downStatus.summary).toBe("stopped");
    expect(downStatus.agents.every((agent) => agent.status === "stopped")).toBe(true);
    expect(downStatus.sessions.every((session) => session.status === "disconnected")).toBe(true);
    expect(processManager.stopped.length).toBe(2);
  });

  it("filters by role and tails logs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buildfleet-fleet-"));
    const rolesPath = path.join(tempDir, ".buildfleet/roles.json");
    const runtimeDir = path.join(tempDir, ".buildfleet/runtime");
    const logDir = path.join(tempDir, ".buildfleet/logs/agents");

    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(
      rolesPath,
      JSON.stringify(
        { agents: [{ id: "pm-agent", role: "Orchestrator" }, { id: "dev-agent", role: "Developer" }] },
        null,
        2,
      ),
      "utf8",
    );

    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, "dev-agent.log"), "line1\nline2\nline3\n", "utf8");

    const service = new FleetService(
      rolesPath,
      runtimeDir,
      logDir,
      new FakeProcessManager() as never,
      new FakeAppServerClient() as never,
    );

    await service.up({ role: "Developer", detached: true });
    const status = await service.status("Developer");
    expect(status.agents).toHaveLength(1);
    expect(status.agents[0]?.id).toBe("dev-agent");

    const logs = await service.logs({ role: "Developer", tail: 2 });
    expect(logs).toContain("[dev-agent]");
    expect(logs).not.toContain("line1");
    expect(logs).toContain("line2");
    expect(logs).toContain("line3");
  });
});
