import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { AppServerClient } from "../src/infra/appserver/app-server-client.js";

class MockChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = null;
  public readonly pid = 4242;
  public readonly exitCode: number | null = null;
  public readonly signalCode: NodeJS.Signals | null = null;
  public kill = vi.fn(() => true);
  public unref = vi.fn();
}

describe("AppServerClient", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("passes codex config through -c flags and reuses model settings for thread and turn requests", async () => {
    const child = new MockChildProcess();
    const requests: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];

    child.stdin.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
        requests.push(request);

        if (typeof request.id !== "number") {
          continue;
        }

        if (request.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          continue;
        }

        if (request.method === "thread/start") {
          child.stdout.write(
            `${JSON.stringify({ id: request.id, result: { thread: { id: "thread-123" } } })}\n`,
          );
          continue;
        }

        if (request.method === "turn/start") {
          child.stdout.write(
            `${JSON.stringify({ id: request.id, result: { turn: { id: "turn-456" } } })}\n`,
          );
        }
      }
    });

    spawnMock.mockReturnValue(child);

    const client = new AppServerClient();
    await client.startAgent({
      agentId: "developer-1",
      role: "Developer",
      prompt: "prompt",
      cwd: "/workspace",
      detached: false,
      codexConfig: {
        model: "gpt-5-mini-codex",
        model_reasoning_effort: "medium",
        experimental: {
          trace: true,
        },
      },
    });

    await client.handshake("developer-1");
    await client.startThread("developer-1", {
      baseInstructions: "All responses must be in ja.",
    });
    await client.startTurn("developer-1", {
      threadId: "thread-123",
      input: [{ type: "text", text: "hello" }],
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "-a",
        "never",
        "-c",
        "model=gpt-5-mini-codex",
        "-c",
        "model_reasoning_effort=medium",
        "-c",
        "experimental.trace=true",
        "app-server",
      ],
      expect.objectContaining({
        cwd: "/workspace",
        detached: false,
      }),
    );

    const startThreadRequest = requests.find((request) => request.method === "thread/start");
    expect(startThreadRequest?.params).toMatchObject({
      model: "gpt-5-mini-codex",
      baseInstructions: "All responses must be in ja.",
    });

    const startTurnRequest = requests.find((request) => request.method === "turn/start");
    expect(startTurnRequest?.params).toMatchObject({
      model: "gpt-5-mini-codex",
      effort: "medium",
    });
  });
});
