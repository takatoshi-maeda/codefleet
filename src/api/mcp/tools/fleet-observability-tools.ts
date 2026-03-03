import { z } from "zod";
import type { AgentMount } from "ai-kit/hono";
import {
  executeFleetActivityListTool,
  executeFleetActivityWatchTool,
  executeFleetLogsTailTool,
  FleetActivityListInputSchema,
  FleetActivityWatchInputSchema,
  FleetLogsTailInputSchema,
} from "../../../application/tools/fleet-observability-tools.js";
import type {
  FleetActivityWatchEvent,
  FleetLogsWatchEvent,
  FleetObservabilityService,
} from "../../../domain/fleet/fleet-observability-service.js";
import { CodefleetError } from "../../../shared/errors.js";

interface McpToolResult extends Record<string, unknown> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

interface RegisterFleetObservabilityToolsOptions {
  agentName?: string;
}

interface NotificationSenderExtra {
  sendNotification?: (input: { method: string; params: Record<string, unknown> }) => Promise<void>;
}

export function registerFleetObservabilityTools(
  mount: AgentMount,
  service: FleetObservabilityService,
  _options: RegisterFleetObservabilityToolsOptions = {},
): void {
  mount.mcpServer.registerTool(
    "fleet.activity.list",
    {
      description: "List role-level fleet activity",
      inputSchema: FleetActivityListInputSchema.shape,
    },
    async (args) =>
      executeTool(async () => executeFleetActivityListTool(service, args)),
  );

  mount.mcpServer.registerTool(
    "fleet.activity.watch",
    {
      description: "Watch role-level fleet activity transitions",
      inputSchema: FleetActivityWatchInputSchema.shape,
    },
    async (args, extra) =>
      executeTool(async () =>
        executeFleetActivityWatchTool(service, args, async (event) => {
          await sendWatchNotification(extra as NotificationSenderExtra, event);
        }),
      ),
  );

  mount.mcpServer.registerTool(
    "fleet.logs.tail",
    {
      description: "Tail role-scoped agent logs",
      inputSchema: FleetLogsTailInputSchema.shape,
    },
    async (args, extra) =>
      executeTool(async () =>
        executeFleetLogsTailTool(service, args, async (event) => {
          await sendWatchNotification(extra as NotificationSenderExtra, event);
        }),
      ),
  );
}

async function sendWatchNotification(
  extra: NotificationSenderExtra,
  event: FleetActivityWatchEvent | FleetLogsWatchEvent,
): Promise<void> {
  if (!extra.sendNotification) {
    return;
  }
  await extra.sendNotification({
    method: event.type,
    params: event.payload,
  });
}

async function executeTool(run: () => Promise<object>): Promise<McpToolResult> {
  try {
    const payload = (await run()) as Record<string, unknown>;
    return success(payload);
  } catch (error) {
    return mapToolError(error);
  }
}

function success(payload: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

function mapToolError(error: unknown): McpToolResult {
  if (error instanceof CodefleetError) {
    const payload = {
      error: {
        code: error.code,
        message: error.message,
      },
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }

  if (error instanceof z.ZodError) {
    const payload = {
      error: {
        code: "ERR_VALIDATION",
        message: error.issues.map((issue) => issue.message).join("; "),
      },
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }

  const payload = {
    error: {
      code: "ERR_UNEXPECTED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}
