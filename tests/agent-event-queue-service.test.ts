import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEventQueueService } from "../src/domain/events/agent-event-queue-service.js";
import type { AgentRuntimeCollection } from "../src/domain/agent-runtime-model.js";

describe("AgentEventQueueService", () => {
  it("enqueues docs.update messages only for running subscribed roles", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-queue-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    await fs.mkdir(runtimeDir, { recursive: true });

    const runtimes: AgentRuntimeCollection = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      agents: [
        {
          id: "orchestrator-1",
          role: "Orchestrator",
          status: "running",
          pid: 111,
          cwd: tempDir,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "developer-1",
          role: "Developer",
          status: "running",
          pid: 222,
          cwd: tempDir,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "gatekeeper-1",
          role: "Gatekeeper",
          status: "running",
          pid: 333,
          cwd: tempDir,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    await fs.writeFile(path.join(runtimeDir, "agents.json"), `${JSON.stringify(runtimes, null, 2)}\n`, "utf8");

    const service = new AgentEventQueueService(runtimeDir);
    const result = await service.enqueueToRunningAgents({ type: "docs.update", paths: ["docs/spec.md"] });

    expect(result.enqueuedAgentIds).toEqual(["gatekeeper-1"]);
    expect(result.files).toHaveLength(1);
    expect(path.basename(result.files[0] ?? "")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.json$/u);

    const messageFiles = await Promise.all(result.files.map((filePath) => fs.readFile(filePath, "utf8")));
    const messages = messageFiles.map(
      (raw) =>
        JSON.parse(raw) as {
          id: string;
          agentId: string;
          agentRole: string;
          event: { type: string; paths: string[] };
          source: { command: string };
        },
    );

    expect(messages.map((message) => message.agentId).sort()).toEqual(["gatekeeper-1"]);
    expect(messages.every((message) => message.agentRole === "Gatekeeper")).toBe(true);
    expect(messages.every((message) => message.event.type === "docs.update")).toBe(true);
    expect(messages.every((message) => message.event.paths[0] === "docs/spec.md")).toBe(true);
    expect(messages.every((message) => message.source.command === "codefleet trigger docs.update")).toBe(true);
    expect(messages.every((message) => typeof message.id === "string" && message.id.length === 26)).toBe(true);
  });

  it("enqueues acceptance-test.update messages for running orchestrator", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-queue-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    await fs.mkdir(runtimeDir, { recursive: true });

    const runtimes: AgentRuntimeCollection = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      agents: [
        {
          id: "orchestrator-1",
          role: "Orchestrator",
          status: "running",
          pid: 111,
          cwd: tempDir,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "gatekeeper-1",
          role: "Gatekeeper",
          status: "running",
          pid: 333,
          cwd: tempDir,
          startedAt: "2026-01-01T00:00:00.000Z",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    await fs.writeFile(path.join(runtimeDir, "agents.json"), `${JSON.stringify(runtimes, null, 2)}\n`, "utf8");

    const service = new AgentEventQueueService(runtimeDir);
    const result = await service.enqueueToRunningAgents({ type: "acceptance-test.update" });

    expect(result.enqueuedAgentIds).toEqual(["orchestrator-1"]);
    expect(result.files).toHaveLength(1);
  });
});
