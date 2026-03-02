import { z } from "zod";
import type { AgentMount } from "../../../../vendor/ai-kit/src/hono/index.js";
import type {
  FleetActivityWatchEvent,
  FleetLogsTailResult,
  FleetObservabilityService,
} from "../../../domain/agents/fleet-observability-service.js";
import { CodefleetError } from "../../../shared/errors.js";

const AgentRoleSchema = z.enum(["Orchestrator", "Developer", "Polisher", "Gatekeeper", "Reviewer"]);

const FleetActivityListInputSchema = z.object({
  roles: z.array(AgentRoleSchema).optional(),
}).strict();

const FleetActivityWatchInputSchema = z.object({
  roles: z.array(AgentRoleSchema).optional(),
  includeAgents: z.boolean().optional(),
  heartbeatSec: z.number().int().min(5).max(60).optional(),
  maxDurationSec: z.number().int().min(1).max(1800).optional(),
  notificationToken: z.string().min(1).optional(),
});

const FleetLogsTailInputSchema = z.object({
  role: AgentRoleSchema.optional(),
  agentRole: AgentRoleSchema.optional(),
  tailPerAgent: z.number().int().min(1).max(1000).optional(),
  contains: z.string().optional(),
  stream: z.boolean().optional(),
  notificationToken: z.string().min(1).optional(),
});

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
      executeTool(async () => {
        const input = FleetActivityListInputSchema.parse(normalizeToolArgs(args));
        return service.listActivity({
          roles: input.roles,
        });
      }),
  );

  mount.mcpServer.registerTool(
    "fleet.activity.watch",
    {
      description: "Watch role-level fleet activity transitions",
      inputSchema: FleetActivityWatchInputSchema.shape,
    },
    async (args, extra) =>
      executeTool(async () => {
        const input = FleetActivityWatchInputSchema.parse(normalizeToolArgs(args));
        return service.watchActivity({
          roles: input.roles,
          includeAgents: input.includeAgents ?? false,
          heartbeatSec: input.heartbeatSec ?? 15,
          maxDurationSec: input.maxDurationSec ?? 300,
          notificationToken: input.notificationToken,
          onEvent: async (event) => {
            await sendWatchNotification(extra as NotificationSenderExtra, event);
          },
        });
      }),
  );

  mount.mcpServer.registerTool(
    "fleet.logs.tail",
    {
      description: "Tail role-scoped agent logs",
      inputSchema: FleetLogsTailInputSchema.shape,
    },
    async (args, extra) =>
      executeTool(async () => {
        const input = FleetLogsTailInputSchema.parse(normalizeToolArgs(args));
        const requestedRole = resolveLogsTailRole(input);
        const payload = await service.tailLogs({
          role: requestedRole,
          tailPerAgent: input.tailPerAgent ?? 100,
          contains: input.contains,
        });
        if (input.stream && (extra as NotificationSenderExtra)?.sendNotification) {
          await sendLogStreamNotifications(extra as NotificationSenderExtra, payload, input.notificationToken);
        }
        return payload;
      }),
  );
}

async function sendWatchNotification(
  extra: NotificationSenderExtra,
  event: FleetActivityWatchEvent,
): Promise<void> {
  if (!extra.sendNotification) {
    return;
  }
  await extra.sendNotification({
    method: event.type,
    params: event.payload,
  });
}

async function sendLogStreamNotifications(
  extra: NotificationSenderExtra,
  payload: FleetLogsTailResult,
  notificationToken: string | undefined,
): Promise<void> {
  if (!extra.sendNotification) {
    return;
  }
  let totalLineCount = 0;
  for (const agent of payload.agents) {
    totalLineCount += agent.lines.length;
    await extra.sendNotification({
      method: "fleet.logs.chunk",
      params: withToken(
        {
          role: payload.role,
          agentId: agent.agentId,
          lines: agent.lines,
        },
        notificationToken,
      ),
    });
  }
  await extra.sendNotification({
    method: "fleet.logs.complete",
    params: withToken(
      {
        role: payload.role,
        agentCount: payload.agents.length,
        lineCount: totalLineCount,
      },
      notificationToken,
    ),
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

function normalizeToolArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  if ("arguments" in value) {
    const wrapped = (value as { arguments?: unknown }).arguments;
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      return wrapped as Record<string, unknown>;
    }
  }
  return value as Record<string, unknown>;
}

function withToken(payload: Record<string, unknown>, token: string | undefined): Record<string, unknown> {
  if (!token) {
    return payload;
  }
  return { ...payload, notificationToken: token };
}

function resolveLogsTailRole(input: { role?: z.infer<typeof AgentRoleSchema>; agentRole?: z.infer<typeof AgentRoleSchema> }) {
  if (input.role && input.agentRole && input.role !== input.agentRole) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: "role and agentRole must match when both are specified",
        path: ["role"],
      },
    ]);
  }
  return input.agentRole ?? input.role;
}
