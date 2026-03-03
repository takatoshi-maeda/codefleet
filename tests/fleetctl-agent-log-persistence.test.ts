import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { enqueueFleetAgentLogWrite, flushFleetAgentLogWritesForTest } from "../src/cli/commands/fleetctl.js";

describe("fleetctl agent log persistence", () => {
  it("persists fleet.agent.output messages to per-agent log files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-agent-log-"));
    const logDir = path.join(tempDir, ".codefleet", "logs", "agents");

    enqueueFleetAgentLogWrite(
      {
        ts: "2026-03-03T00:00:00.000Z",
        event: "fleet.agent.output",
        agentId: "orchestrator-1",
        message: "assistant: handled event",
      },
      logDir,
    );
    await flushFleetAgentLogWritesForTest();

    const raw = await fs.readFile(path.join(logDir, "orchestrator-1.log"), "utf8");
    expect(raw).toContain("[2026-03-03T00:00:00.000Z] assistant: handled event");
  });

  it("ignores non-agent events and preserves summary lines for fleet.agent.event", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-agent-log-"));
    const logDir = path.join(tempDir, ".codefleet", "logs", "agents");

    enqueueFleetAgentLogWrite({ event: "fleet.up.completed", summary: "fleet started" }, logDir);
    enqueueFleetAgentLogWrite(
      {
        ts: "2026-03-03T00:00:01.000Z",
        event: "fleet.agent.event",
        agentId: "developer-1",
        summary: "turn completed: thread/turn",
      },
      logDir,
    );
    await flushFleetAgentLogWritesForTest();

    await expect(fs.stat(path.join(logDir, "orchestrator-1.log"))).rejects.toMatchObject({ code: "ENOENT" });
    const raw = await fs.readFile(path.join(logDir, "developer-1.log"), "utf8");
    expect(raw).toContain("[2026-03-03T00:00:01.000Z] turn completed: thread/turn");
  });
});
