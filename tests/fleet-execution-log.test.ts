import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FleetExecutionLog } from "../src/domain/agents/fleet-execution-log.js";

describe("FleetExecutionLog", () => {
  it("stores append-only execution records and returns latest state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-exec-log-"));
    const filePath = path.join(tempDir, "executions.jsonl");
    const log = new FleetExecutionLog(filePath);

    await log.append({
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      agentId: "developer-1",
      role: "Developer",
      eventType: "backlog.epic.ready",
      epicId: "E-001",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "running",
    });
    await log.append({
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      agentId: "developer-1",
      role: "Developer",
      eventType: "backlog.epic.ready",
      epicId: "E-001",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z",
      durationMs: 3000,
      status: "success",
    });
    await log.append({
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      agentId: "reviewer-1",
      role: "Reviewer",
      eventType: "backlog.epic.review.ready",
      epicId: "E-001",
      startedAt: "2026-01-01T00:00:05.000Z",
      status: "running",
    });

    const listed = await log.list({ status: "running", limit: 10 });
    expect(listed.executions).toHaveLength(1);
    expect(listed.executions[0]?.executionId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FB0");
  });

  it("supports cursor pagination by startedAt + executionId", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-exec-log-"));
    const filePath = path.join(tempDir, "executions.jsonl");
    const log = new FleetExecutionLog(filePath);

    await log.append({
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
      agentId: "developer-1",
      role: "Developer",
      eventType: "backlog.epic.ready",
      startedAt: "2026-01-01T00:00:02.000Z",
      status: "success",
      finishedAt: "2026-01-01T00:00:04.000Z",
      durationMs: 2000,
    });
    await log.append({
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
      agentId: "developer-1",
      role: "Developer",
      eventType: "backlog.epic.ready",
      startedAt: "2026-01-01T00:00:01.000Z",
      status: "failed",
      finishedAt: "2026-01-01T00:00:03.000Z",
      durationMs: 2000,
      error: { message: "failed" },
    });

    const firstPage = await log.list({ role: "Developer", limit: 1 });
    expect(firstPage.executions).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await log.list({ role: "Developer", limit: 1, cursor: firstPage.nextCursor });
    expect(secondPage.executions).toHaveLength(1);
    expect(secondPage.executions[0]?.executionId).not.toBe(firstPage.executions[0]?.executionId);
  });
});
