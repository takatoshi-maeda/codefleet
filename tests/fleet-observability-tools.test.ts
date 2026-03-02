import { describe, expect, it, vi } from "vitest";
import { registerFleetObservabilityTools } from "../src/api/mcp/tools/fleet-observability-tools.js";

interface RegisteredTool {
  name: string;
  handler: (args: unknown, extra?: unknown) => Promise<{
    isError: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
}

function createTestMount() {
  const tools: RegisteredTool[] = [];
  return {
    mount: {
      mcpServer: {
        registerTool: (
          name: string,
          _meta: unknown,
          handler: RegisteredTool["handler"],
        ) => {
          tools.push({ name, handler });
        },
      },
    },
    tools,
  };
}

function getToolHandler(tools: RegisteredTool[], name: string) {
  const registered = tools.find((tool) => tool.name === name);
  if (!registered) {
    throw new Error(`tool not found in test mount: ${name}`);
  }
  return registered.handler;
}

describe("registerFleetObservabilityTools", () => {
  it("maps invalid tool input to ERR_VALIDATION", async () => {
    const service = {
      listActivity: vi.fn(),
      watchActivity: vi.fn(),
      listExecutions: vi.fn(),
      watchExecutions: vi.fn(),
      tailLogs: vi.fn(),
    };
    const { mount, tools } = createTestMount();
    registerFleetObservabilityTools(mount as never, service as never);

    const logsTail = getToolHandler(tools, "fleet.logs.tail");
    const result = await logsTail({ arguments: { tailPerAgent: 0 } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toEqual({
      code: "ERR_VALIDATION",
      message: "Number must be greater than or equal to 1",
    });
  });

  it("rejects includeAgents option in fleet.activity.list", async () => {
    const service = {
      listActivity: vi.fn(),
      watchActivity: vi.fn(),
      listExecutions: vi.fn(),
      watchExecutions: vi.fn(),
      tailLogs: vi.fn(),
    };
    const { mount, tools } = createTestMount();
    registerFleetObservabilityTools(mount as never, service as never);

    const activityList = getToolHandler(tools, "fleet.activity.list");
    const result = await activityList({ arguments: { includeAgents: true } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toEqual({
      code: "ERR_VALIDATION",
      message: "Unrecognized key(s) in object: 'includeAgents'",
    });
  });

  it("accepts omitted agentRole and requests all roles", async () => {
    const service = {
      listActivity: vi.fn(),
      watchActivity: vi.fn(),
      listExecutions: vi.fn(),
      watchExecutions: vi.fn(),
      tailLogs: vi.fn(async () => ({
        role: null,
        agents: [{ agentId: "developer-1", role: "Developer", lines: [], lineCount: 0, truncated: false }],
      })),
    };
    const { mount, tools } = createTestMount();
    registerFleetObservabilityTools(mount as never, service as never);

    const tail = getToolHandler(tools, "fleet.logs.tail");
    const result = await tail({ arguments: { tailPerAgent: 10 } });

    expect(result.isError).toBe(false);
    expect(service.tailLogs).toHaveBeenCalledWith({
      role: undefined,
      tailPerAgent: 10,
      contains: undefined,
    });
  });

  it("sends watch notifications with provided notificationToken", async () => {
    const service = {
      listActivity: vi.fn(),
      watchActivity: vi.fn(async (input: { onEvent?: (event: { type: string; payload: Record<string, unknown> }) => Promise<void> }) => {
        await input.onEvent?.({
          type: "fleet.activity.snapshot",
          payload: { updatedAt: "2026-01-01T00:00:00.000Z", roles: [], notificationToken: "tok-1" },
        });
        return {
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          eventCount: 1,
          reason: "timeout",
        };
      }),
      listExecutions: vi.fn(),
      watchExecutions: vi.fn(),
      tailLogs: vi.fn(),
    };
    const { mount, tools } = createTestMount();
    registerFleetObservabilityTools(mount as never, service as never);
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

    const watch = getToolHandler(tools, "fleet.activity.watch");
    const result = await watch(
      { arguments: { notificationToken: "tok-1", maxDurationSec: 1, heartbeatSec: 5 } },
      {
        sendNotification: async (event: { method: string; params: Record<string, unknown> }) => {
          notifications.push(event);
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(notifications[0]?.method).toBe("fleet.activity.snapshot");
    expect(notifications[0]?.params.notificationToken).toBe("tok-1");
  });

  it("streams log chunks when stream=true", async () => {
    const service = {
      listActivity: vi.fn(),
      watchActivity: vi.fn(),
      listExecutions: vi.fn(),
      watchExecutions: vi.fn(),
      tailLogs: vi.fn(async () => ({
        role: "Developer",
        agents: [
          { agentId: "developer-1", lines: ["line-a"], lineCount: 1, truncated: false },
          { agentId: "developer-2", lines: ["line-b"], lineCount: 1, truncated: false },
        ],
      })),
    };
    const { mount, tools } = createTestMount();
    registerFleetObservabilityTools(mount as never, service as never);
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

    const tail = getToolHandler(tools, "fleet.logs.tail");
    const result = await tail(
      { arguments: { role: "Developer", stream: true, notificationToken: "tok-2" } },
      {
        sendNotification: async (event: { method: string; params: Record<string, unknown> }) => {
          notifications.push(event);
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(notifications.map((entry) => entry.method)).toEqual([
      "fleet.logs.chunk",
      "fleet.logs.chunk",
      "fleet.logs.complete",
    ]);
    expect(notifications[0]?.params.notificationToken).toBe("tok-2");
  });
});
