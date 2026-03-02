import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FleetExecutionLog } from "../src/domain/agents/fleet-execution-log.js";
import { FleetObservabilityService } from "../src/domain/agents/fleet-observability-service.js";

describe("FleetObservabilityService", () => {
  it("aggregates activity by role with busy/idle counts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-observability-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const logDir = path.join(tempDir, ".codefleet", "logs", "agents");
    const executionLog = new FleetExecutionLog(path.join(runtimeDir, "fleet", "executions.jsonl"));

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(path.join(runtimeDir, "events", "agents", "developer-1", "processing"), { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "agents.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          agents: [
            {
              id: "developer-1",
              role: "Developer",
              status: "running",
              pid: 1234,
              cwd: process.cwd(),
              startedAt: "2026-01-01T00:00:00.000Z",
              lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "developer-2",
              role: "Developer",
              status: "running",
              pid: 1235,
              cwd: process.cwd(),
              startedAt: "2026-01-01T00:00:00.000Z",
              lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(runtimeDir, "events", "agents", "developer-1", "processing", "m1.json"), "{}", "utf8");
    await executionLog.append({
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      agentId: "developer-1",
      role: "Developer",
      eventType: "backlog.epic.ready",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "running",
    });

    const service = new FleetObservabilityService(runtimeDir, logDir, executionLog);
    const result = await service.listActivity({ roles: ["Developer"] });
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]?.busyAgents).toBe(1);
    expect(result.roles[0]?.idleAgents).toBe(1);
    expect(result.roles[0]?.inflightTasks).toBe(1);
  });

  it("tails logs per role and applies contains filter", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-observability-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const logDir = path.join(tempDir, ".codefleet", "logs", "agents");

    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, "agents.json"),
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          agents: [
            {
              id: "reviewer-1",
              role: "Reviewer",
              status: "running",
              pid: 3001,
              cwd: process.cwd(),
              startedAt: "2026-01-01T00:00:00.000Z",
              lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(logDir, "reviewer-1.log"), "line-1\nmatch-line\nline-3\n", "utf8");

    const service = new FleetObservabilityService(runtimeDir, logDir);
    const result = await service.tailLogs({ role: "Reviewer", tailPerAgent: 10, contains: "match" });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.lines).toEqual(["match-line"]);
    expect(result.agents[0]?.lineCount).toBe(1);
  });
});
