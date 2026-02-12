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

    const messageFiles = await Promise.all(result.files.map((filePath) => fs.readFile(filePath, "utf8")));
    const messages = messageFiles.map((raw) => JSON.parse(raw) as { agentId: string; event: { type: string; paths: string[] } });

    expect(messages.map((message) => message.agentId).sort()).toEqual(["gatekeeper-1"]);
    expect(messages.every((message) => message.event.type === "docs.update")).toBe(true);
    expect(messages.every((message) => message.event.paths[0] === "docs/spec.md")).toBe(true);
  });
});
