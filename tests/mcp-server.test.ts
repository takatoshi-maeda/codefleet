import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMClient, LLMChatInput, LLMMessage } from "ai-kit";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";
import type { CodefleetFrontDeskRuntimeConfig } from "../src/agents/front-desk.js";
import { McpApiServer } from "../src/api/mcp/server.js";

describe("McpApiServer", () => {
  it("exposes codefleet.front-desk in /api/mcp and reports ready status", async () => {
    const port = 39000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: `.codefleet/runtime/mcp-test-${Date.now().toString(16)}`,
      frontDesk: createFrontDeskMockConfig(),
    });

    try {
      await server.start();
      const listResponse = await fetch(`http://127.0.0.1:${port}/api/mcp`);
      const listJson = (await listResponse.json()) as { agents?: Array<{ name: string }> };
      expect(listResponse.status).toBe(200);
      expect(listJson.agents?.some((agent) => agent.name === "codefleet.front-desk")).toBe(true);

      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/codefleet.front-desk/status`);
      const statusJson = (await statusResponse.json()) as { state?: string };
      expect(statusResponse.status).toBe(200);
      expect(statusJson.state).toBe("ready");

      const corsResponse = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
        headers: { origin: "http://localhost:8081" },
      });
      expect(corsResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    } finally {
      await server.stop();
    }
  });

  it("serves backlog tools via tools/call bridge with success and domain errors", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const backlogService = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const epic = await backlogService.addEpic({ title: "e1", acceptanceTestIds: [] });
    const item = await backlogService.addItem({ epicId: epic.id, title: "i1", acceptanceTestIds: [] });

    const port = 40000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      backlogService,
      frontDesk: createFrontDeskMockConfig(),
    });
    try {
      await server.start();

      const epicList = await callTool(port, "backlog.epic.list", {});
      expect(epicList.result?.isError).toBe(false);
      expect(epicList.result?.structuredContent?.count).toBe(1);

      const epicGet = await callTool(port, "backlog.epic.get", { id: epic.id });
      expect(epicGet.result?.isError).toBe(false);
      expect(epicGet.result?.structuredContent?.epic?.id).toBe(epic.id);

      const itemList = await callTool(port, "backlog.item.list", { epicId: epic.id });
      expect(itemList.result?.isError).toBe(false);
      expect(itemList.result?.structuredContent?.count).toBe(1);

      const itemGet = await callTool(port, "backlog.item.get", { id: item.id });
      expect(itemGet.result?.isError).toBe(false);
      expect(itemGet.result?.structuredContent?.item?.id).toBe(item.id);

      const activityList = await callTool(port, "fleet.activity.list", {});
      expect(activityList.result?.isError).toBe(false);
      expect(Array.isArray(activityList.result?.structuredContent?.roles)).toBe(true);

      const logsTailStreamResponse = await fetch(
        `http://127.0.0.1:${port}/api/mcp/codefleet.front-desk/tools/call/fleet.logs.tail`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ arguments: { stream: true, tailPerAgent: 10, maxDurationSec: 1, heartbeatSec: 5 } }),
        },
      );
      expect(logsTailStreamResponse.status).toBe(200);
      expect(logsTailStreamResponse.headers.get("content-type")).toContain("text/event-stream");
      const logsTailStreamBody = await logsTailStreamResponse.text();
      expect(logsTailStreamBody).toContain("\"method\":\"fleet.logs.complete\"");

      const notFound = await callTool(port, "backlog.item.get", { id: "I-404" });
      expect(notFound.result?.isError).toBe(true);
      expect(notFound.result?.structuredContent?.error?.code).toBe("ERR_NOT_FOUND");

      const validation = await callTool(port, "backlog.item.get", {});
      expect(validation.result?.isError).toBe(true);
      expect(validation.result?.structuredContent?.error?.code).toBe("ERR_VALIDATION");

      const agentGet = await callTool(port, "agent.run", { message: `${epic.id} の状況を教えて` });
      expect(agentGet.result?.isError).toBe(false);
      expect(String(agentGet.result?.structuredContent?.message ?? "")).toContain("tool: backlog_epic_get");

      const agentList = await callTool(port, "agent.run", { message: "item一覧を見せて" });
      expect(agentList.result?.isError).toBe(false);
      expect(String(agentList.result?.structuredContent?.message ?? "")).toContain("tool: backlog_item_list");
    } finally {
      await server.stop();
    }
  });

  it("writes backlog tool audit logs as JSONL", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-audit-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const auditLogPath = path.join(tempDir, ".codefleet/runtime/mcp/tool-executions.jsonl");

    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const backlogService = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    await backlogService.addEpic({ title: "audit target", acceptanceTestIds: [] });

    const port = 41000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      toolAuditLogPath: auditLogPath,
      backlogService,
      frontDesk: createFrontDeskMockConfig(),
    });

    try {
      await server.start();
      const listResult = await callTool(port, "backlog.epic.list", {});
      expect(listResult.result?.isError).toBe(false);
    } finally {
      await server.stop();
    }

    const raw = await fs.readFile(auditLogPath, "utf8");
    const lines = raw.trim().split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      agent?: string;
      tool?: string;
      durationMs?: number;
      isError?: boolean;
      resultCount?: number;
    };
    expect(parsed.agent).toBe("codefleet.front-desk");
    expect(parsed.tool).toBe("backlog.epic.list");
    expect(parsed.isError).toBe(false);
    expect(typeof parsed.durationMs).toBe("number");
    expect(parsed.resultCount).toBe(1);
  });

  it("fails fast when llm mode is configured without api key", async () => {
    const port = 42000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: `.codefleet/runtime/mcp-test-${Date.now().toString(16)}`,
      frontDesk: {
        llm: {
          provider: "openai",
          model: "gpt-5.3-codex",
          apiKeyEnv: "CODEFLEET_TEST_MISSING_KEY",
        },
      },
    });
    await expect(server.start()).rejects.toThrow(/CODEFLEET_TEST_MISSING_KEY/);
  });

  it("serves agent.run in llm mode using backlog tools", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-llm-agent-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const backlogService = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const epic = await backlogService.addEpic({ title: "llm-epic", acceptanceTestIds: [] });

    let streamCallCount = 0;
    const streamInputs: LLMChatInput[] = [];
    const mockClient: LLMClient = {
      provider: "openai",
      model: "mock-mcp-llm",
      capabilities: {
        supportsReasoning: true,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsImages: false,
        contextWindowSize: 8_000,
      },
      estimateTokens: () => 0,
      invoke: async () => {
        throw new Error("invoke should not be called");
      },
      stream: async function* (input: LLMChatInput) {
        streamCallCount += 1;
        streamInputs.push(input);
        if (streamCallCount === 1) {
          yield {
            type: "response.completed",
            result: {
              type: "tool_use",
              content: null,
              toolCalls: [
                {
                  id: "tc-epic-get",
                  name: "backlog_epic_get",
                  arguments: { id: epic.id },
                },
              ],
              usage: emptyUsage(),
              responseId: "resp-1",
              finishReason: "tool_use",
            },
          };
          return;
        }
        yield {
          type: "response.completed",
          result: {
            type: "message",
            content: `Epic ${epic.id} を確認しました。`,
            toolCalls: [],
            usage: emptyUsage(),
            responseId: "resp-2",
            finishReason: "stop",
          },
        };
      },
    };

    const port = 43000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      backlogService,
      frontDesk: {
        llm: { provider: "openai", model: "gpt-5.3-codex", apiKey: "test-key" },
        clientFactory: () => mockClient,
        maxTurns: 4,
      },
    });

    try {
      await server.start();
      const agentRun = await callTool(port, "agent.run", { message: "epic detail please" });
      expect(agentRun.result?.isError).toBe(false);
      expect(String(agentRun.result?.structuredContent?.message ?? "")).toContain(epic.id);
      expect(streamCallCount).toBe(2);
      expect(streamInputs[0]?.tools?.map((tool) => tool.name)).toEqual([
        "backlog_epic_list",
        "backlog_epic_get",
        "backlog_item_list",
        "backlog_item_get",
        "feedback_note_create",
        "feedback_note_list",
        "ListDirectory",
        "ReadFile",
      ]);
    } finally {
      await server.stop();
    }
  });
});

async function callTool(port: number, tool: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp/codefleet.front-desk/tools/call/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ arguments: args }),
  });
  expect(response.status).toBe(200);
  const bodyText = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLines = bodyText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .filter((line) => line.length > 0);
    const lastData = dataLines[dataLines.length - 1] ?? "{}";
    return JSON.parse(lastData) as {
      result?: {
        isError?: boolean;
        structuredContent?: Record<string, any>;
      };
    };
  }
  return JSON.parse(bodyText) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, any>;
    };
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
  };
}

function createFrontDeskMockConfig(): CodefleetFrontDeskRuntimeConfig {
  return {
    llm: { provider: "openai", model: "gpt-5.3-codex", apiKey: "test-key" },
    clientFactory: () => createDeterministicFrontDeskMockClient(),
    maxTurns: 4,
  };
}

function createDeterministicFrontDeskMockClient(): LLMClient {
  return {
    provider: "openai",
    model: "mock-front-desk",
    capabilities: {
      supportsReasoning: true,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsImages: false,
      contextWindowSize: 8_000,
    },
    estimateTokens: () => 0,
    invoke: async () => {
      throw new Error("invoke should not be called");
    },
    stream: async function* (input: LLMChatInput) {
      const lastToolMessage = findLastToolMessage(input.messages);
      if (lastToolMessage) {
        const resolvedToolName = lastToolMessage.name ?? "unknown";
        yield {
          type: "response.completed",
          result: {
            type: "message",
            content: `tool: ${resolvedToolName}`,
            toolCalls: [],
            usage: emptyUsage(),
            responseId: "resp-finish",
            finishReason: "stop",
          },
        };
        return;
      }

      const userMessage = findLastUserMessage(input.messages).toLowerCase();
      const selectedToolName = userMessage.includes("item")
        ? "backlog_item_list"
        : /e-\d{3,}/i.test(userMessage)
          ? "backlog_epic_get"
          : "backlog_epic_list";
      const selectedArgs = selectedToolName === "backlog_epic_get" ? { id: findFirstEpicId(userMessage) } : {};

      yield {
        type: "response.completed",
        result: {
          type: "tool_use",
          content: null,
          toolCalls: [
            {
              id: "tc-deterministic",
              name: selectedToolName,
              arguments: selectedArgs,
            },
          ],
          usage: emptyUsage(),
          responseId: "resp-tool",
          finishReason: "tool_use",
        },
      };
    },
  };
}

function findLastToolMessage(messages: LLMMessage[]): LLMMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "tool") {
      return messages[index];
    }
  }
  return undefined;
}

function findLastUserMessage(messages: LLMMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && typeof messages[index].content === "string") {
      return messages[index].content;
    }
  }
  return "";
}

function findFirstEpicId(message: string): string {
  const matched = message.match(/\be-\d{3,}\b/i);
  return matched?.[0]?.toUpperCase() ?? "E-001";
}
