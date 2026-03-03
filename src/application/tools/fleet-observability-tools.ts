import { z } from "zod";
import type {
  FleetActivityWatchEvent,
  FleetLogsWatchEvent,
  FleetObservabilityService,
} from "../../domain/fleet/fleet-observability-service.js";
import { normalizeToolArgs } from "./tool-args.js";

// Keep parsing/defaulting here so protocol adapters only translate transport
// concerns (MCP responses/notifications) and do not own use-case behavior.
const AgentRoleSchema = z.enum(["Orchestrator", "Developer", "Polisher", "Gatekeeper", "Reviewer"]);

export const FleetActivityListInputSchema = z.object({
  roles: z.array(AgentRoleSchema).optional(),
}).strict();

export const FleetActivityWatchInputSchema = z.object({
  roles: z.array(AgentRoleSchema).optional(),
  includeAgents: z.boolean().optional(),
  heartbeatSec: z.number().int().min(5).max(60).optional(),
  maxDurationSec: z.number().int().min(1).max(1800).optional(),
  notificationToken: z.string().min(1).optional(),
});

export const FleetLogsTailInputSchema = z.object({
  role: AgentRoleSchema.optional(),
  agentRole: AgentRoleSchema.optional(),
  agentId: z.string().min(1).optional(),
  tailPerAgent: z.number().int().min(1).max(1000).optional(),
  contains: z.string().optional(),
  stream: z.boolean().optional(),
  heartbeatSec: z.number().int().min(5).max(60).optional(),
  maxDurationSec: z.number().int().min(1).max(1800).optional(),
  notificationToken: z.string().min(1).optional(),
});

export async function executeFleetActivityListTool(service: FleetObservabilityService, args: unknown): Promise<object> {
  const input = FleetActivityListInputSchema.parse(normalizeToolArgs(args));
  return service.listActivity({ roles: input.roles });
}

export async function executeFleetActivityWatchTool(
  service: FleetObservabilityService,
  args: unknown,
  onEvent?: (event: FleetActivityWatchEvent) => Promise<void>,
): Promise<object> {
  const input = FleetActivityWatchInputSchema.parse(normalizeToolArgs(args));
  return service.watchActivity({
    roles: input.roles,
    includeAgents: input.includeAgents ?? false,
    heartbeatSec: input.heartbeatSec ?? 15,
    maxDurationSec: input.maxDurationSec ?? 300,
    notificationToken: input.notificationToken,
    onEvent,
  });
}

export async function executeFleetLogsTailTool(
  service: FleetObservabilityService,
  args: unknown,
  onEvent?: (event: FleetLogsWatchEvent) => Promise<void>,
): Promise<object> {
  const input = FleetLogsTailInputSchema.parse(normalizeToolArgs(args));
  const requestedRole = resolveLogsTailRole(input);
  if (input.stream) {
    return service.watchLogsTail({
      role: requestedRole,
      agentId: input.agentId,
      tailPerAgent: input.tailPerAgent ?? 100,
      contains: input.contains,
      heartbeatSec: input.heartbeatSec ?? 15,
      maxDurationSec: input.maxDurationSec ?? 300,
      notificationToken: input.notificationToken,
      onEvent,
    });
  }

  return service.tailLogs({
    role: requestedRole,
    agentId: input.agentId,
    tailPerAgent: input.tailPerAgent ?? 100,
    contains: input.contains,
  });
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
