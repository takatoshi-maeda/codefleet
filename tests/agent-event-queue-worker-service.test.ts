import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEventQueueWorkerService } from "../src/domain/events/agent-event-queue-worker-service.js";

describe("AgentEventQueueWorkerService", () => {
  it("moves valid pending messages to done and invalid messages to failed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-worker-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const pendingDir = path.join(runtimeDir, "events", "agents", "developer-1", "pending");
    await fs.mkdir(pendingDir, { recursive: true });

    await fs.writeFile(
      path.join(pendingDir, "001-valid.json"),
      `${JSON.stringify({
        id: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "developer-1",
        agentRole: "Reviewer",
        event: { type: "debug.playwright-test" },
        source: { command: "codefleet trigger docs.update" },
      })}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(pendingDir, "002-invalid.json"), "not-json\n", "utf8");

    const service = new AgentEventQueueWorkerService(runtimeDir);
    const result = await service.consume({ agentId: "developer-1", maxMessages: 10 });

    expect(result.consumed).toBe(2);
    expect(result.doneFiles).toHaveLength(1);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason.length).toBeGreaterThan(0);

    await expect(fs.stat(result.doneFiles[0])).resolves.toBeDefined();
    await expect(fs.stat(result.failedFiles[0])).resolves.toBeDefined();
  });

  it("moves message to failed when onMessage handler throws", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-worker-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const pendingDir = path.join(runtimeDir, "events", "agents", "gatekeeper-1", "pending");
    await fs.mkdir(pendingDir, { recursive: true });

    await fs.writeFile(
      path.join(pendingDir, "001-valid.json"),
      `${JSON.stringify({
        id: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "gatekeeper-1",
        agentRole: "Gatekeeper",
        event: { type: "backlog.epic.ready", epicId: "E-001" },
        source: { command: "codefleet trigger docs.update" },
      })}\n`,
      "utf8",
    );

    const service = new AgentEventQueueWorkerService(runtimeDir);
    const result = await service.consume(
      { agentId: "gatekeeper-1", maxMessages: 10 },
      {
        onMessage: async () => {
          throw new Error("injected failure");
        },
      },
    );

    expect(result.consumed).toBe(1);
    expect(result.doneFiles).toHaveLength(0);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        reason: "injected failure",
      }),
    ]);
  });

  it("accepts acceptance-test.required as a valid queue event", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-worker-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const pendingDir = path.join(runtimeDir, "events", "agents", "gatekeeper-1", "pending");
    await fs.mkdir(pendingDir, { recursive: true });

    await fs.writeFile(
      path.join(pendingDir, "001-valid.json"),
      `${JSON.stringify({
        id: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "gatekeeper-1",
        agentRole: "Gatekeeper",
        event: { type: "acceptance-test.required" },
        source: { command: "codefleet trigger acceptance-test.required" },
      })}\n`,
      "utf8",
    );

    const service = new AgentEventQueueWorkerService(runtimeDir);
    const result = await service.consume({ agentId: "gatekeeper-1", maxMessages: 10 });

    expect(result.consumed).toBe(1);
    expect(result.doneFiles).toHaveLength(1);
    expect(result.failedFiles).toHaveLength(0);
  });

  it("accepts source-brief.update as a valid queue event", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-worker-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const pendingDir = path.join(runtimeDir, "events", "agents", "gatekeeper-1", "pending");
    await fs.mkdir(pendingDir, { recursive: true });

    await fs.writeFile(
      path.join(pendingDir, "001-valid.json"),
      `${JSON.stringify({
        id: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "gatekeeper-1",
        agentRole: "Gatekeeper",
        event: {
          type: "source-brief.update",
          briefPath: ".codefleet/data/source-brief/latest.md",
          sourcePaths: ["docs/spec.md"],
        },
        source: { command: "codefleet trigger source-brief.update --brief-path .codefleet/data/source-brief/latest.md" },
      })}\n`,
      "utf8",
    );

    const service = new AgentEventQueueWorkerService(runtimeDir);
    const result = await service.consume({ agentId: "gatekeeper-1", maxMessages: 10 });

    expect(result.consumed).toBe(1);
    expect(result.doneFiles).toHaveLength(1);
    expect(result.failedFiles).toHaveLength(0);
  });

  it("accepts backlog.epic.polish.ready with Polisher role", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-worker-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const pendingDir = path.join(runtimeDir, "events", "agents", "polisher-1", "pending");
    await fs.mkdir(pendingDir, { recursive: true });

    await fs.writeFile(
      path.join(pendingDir, "001-valid.json"),
      `${JSON.stringify({
        id: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "polisher-1",
        agentRole: "Polisher",
        event: { type: "backlog.epic.polish.ready", epicId: "E-100" },
        source: { command: "codefleet trigger backlog.epic.polish.ready --epic-id E-100" },
      })}\n`,
      "utf8",
    );

    const service = new AgentEventQueueWorkerService(runtimeDir);
    const result = await service.consume({ agentId: "polisher-1", maxMessages: 10 });

    expect(result.consumed).toBe(1);
    expect(result.doneFiles).toHaveLength(1);
    expect(result.failedFiles).toHaveLength(0);
  });

  it("accepts feedback-note.create with a valid markdown path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-worker-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const pendingDir = path.join(runtimeDir, "events", "agents", "orchestrator-1", "pending");
    await fs.mkdir(pendingDir, { recursive: true });

    await fs.writeFile(
      path.join(pendingDir, "001-valid.json"),
      `${JSON.stringify({
        id: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "orchestrator-1",
        agentRole: "Orchestrator",
        event: { type: "feedback-note.create", path: ".codefleet/data/feedback-notes/01HXTEST0000000000000000.md" },
        source: { command: "codefleet trigger feedback-note.create --path .codefleet/data/feedback-notes/01.md" },
      })}\n`,
      "utf8",
    );

    const service = new AgentEventQueueWorkerService(runtimeDir);
    const result = await service.consume({ agentId: "orchestrator-1", maxMessages: 10 });

    expect(result.consumed).toBe(1);
    expect(result.doneFiles).toHaveLength(1);
    expect(result.failedFiles).toHaveLength(0);
  });

  it("fails feedback-note.create with path traversal path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-event-worker-"));
    const runtimeDir = path.join(tempDir, ".codefleet", "runtime");
    const pendingDir = path.join(runtimeDir, "events", "agents", "orchestrator-1", "pending");
    await fs.mkdir(pendingDir, { recursive: true });

    await fs.writeFile(
      path.join(pendingDir, "001-invalid.json"),
      `${JSON.stringify({
        id: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        agentId: "orchestrator-1",
        agentRole: "Orchestrator",
        event: { type: "feedback-note.create", path: "../tmp/escape.md" },
        source: { command: "codefleet trigger feedback-note.create --path ../tmp/escape.md" },
      })}\n`,
      "utf8",
    );

    const service = new AgentEventQueueWorkerService(runtimeDir);
    const result = await service.consume({ agentId: "orchestrator-1", maxMessages: 10 });

    expect(result.consumed).toBe(1);
    expect(result.doneFiles).toHaveLength(0);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failures[0]?.reason).toContain("must not contain '..'");
  });
});
