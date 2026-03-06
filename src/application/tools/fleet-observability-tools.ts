import { z } from "zod";
import type { BacklogService } from "../../domain/backlog/backlog-service.js";
import { type BacklogWatchEvent, executeBacklogWatchTool } from "./backlog-tools.js";
import type {
  FleetActivityWatchEvent,
  FleetLogsWatchEvent,
  FleetObservabilityService,
  FleetWatchResult,
} from "../../domain/fleet/fleet-observability-service.js";
import { normalizeToolArgs } from "./tool-args.js";

// Keep parsing/defaulting here so protocol adapters only translate transport
// concerns (MCP responses/notifications) and do not own use-case behavior.
const AgentRoleSchema = z.enum(["Orchestrator", "Curator", "Developer", "Polisher", "Gatekeeper", "Reviewer"]);

export const FleetActivityListInputSchema = z.object({
  roles: z.array(AgentRoleSchema).optional(),
}).strict();

export const FleetWatchInputSchema = z.object({
  heartbeatSec: z.number().int().min(5).max(60).optional(),
  notificationToken: z.string().min(1).optional(),
}).strict();

export const FleetLogsTailInputSchema = z.object({
  role: AgentRoleSchema.optional(),
  agentRole: AgentRoleSchema.optional(),
  agentId: z.string().min(1).optional(),
  tailPerAgent: z.number().int().min(1).max(1000).optional(),
  contains: z.string().optional(),
}).strict();

const FleetWatchTargetSchema = z.enum(["backlog", "activity", "logs"]);
type FleetWatchTarget = z.infer<typeof FleetWatchTargetSchema>;

type FleetWatchEvent =
  | BacklogWatchEvent
  | FleetActivityWatchEvent
  | FleetLogsWatchEvent
  | {
      type: "fleet.watch.error" | "fleet.watch.complete";
      payload: Record<string, unknown>;
    };

export async function executeFleetActivityListTool(service: FleetObservabilityService, args: unknown): Promise<object> {
  const input = FleetActivityListInputSchema.parse(normalizeToolArgs(args));
  return service.listActivity({ roles: input.roles });
}

export async function executeFleetWatchTool(
  backlogService: BacklogService,
  service: FleetObservabilityService,
  args: unknown,
  onEvent?: (event: FleetWatchEvent) => Promise<void>,
  signal?: AbortSignal,
): Promise<object> {
  const input = FleetWatchInputSchema.parse(normalizeToolArgs(args));
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  relayAbort(signal, controller);

  const results: Record<FleetWatchTarget, Record<string, unknown>> = {
    backlog: { eventCount: 0, reason: "server_shutdown" },
    activity: { eventCount: 0, reason: "server_shutdown" },
    logs: { eventCount: 0, reason: "server_shutdown" },
  };

  const watchTasks = [
    runWatch(
      "backlog",
      async () =>
        executeBacklogWatchTool(
          backlogService,
          {
            heartbeatSec: input.heartbeatSec ?? 15,
            notificationToken: input.notificationToken,
          },
          async (event) => emitEvent(onEvent, event),
          controller.signal,
        ),
      results,
      input.notificationToken,
      onEvent,
    ),
    runWatch(
      "activity",
      async () =>
        service.watchActivity({
          includeAgents: false,
          heartbeatSec: input.heartbeatSec ?? 15,
          notificationToken: input.notificationToken,
          onEvent: async (event) => emitEvent(onEvent, event),
          signal: controller.signal,
        }),
      results,
      input.notificationToken,
      onEvent,
    ),
    runWatch(
      "logs",
      async () =>
        service.watchLogsTail({
          tailPerAgent: 100,
          heartbeatSec: input.heartbeatSec ?? 15,
          notificationToken: input.notificationToken,
          onEvent: async (event) => emitEvent(onEvent, event),
          signal: controller.signal,
        }),
      results,
      input.notificationToken,
      onEvent,
    ),
  ];

  await Promise.all(watchTasks);
  const endedAt = new Date().toISOString();
  const reason = controller.signal.aborted ? "client_closed" : "server_shutdown";
  await emitEvent(onEvent, {
    type: "fleet.watch.complete",
    payload: withToken(
      {
        reason,
        startedAt,
        endedAt,
        results,
      },
      input.notificationToken,
    ),
  });

  return {
    startedAt,
    endedAt,
    reason,
    results,
  };
}

export async function executeFleetLogsTailTool(
  service: FleetObservabilityService,
  args: unknown,
): Promise<object> {
  const input = FleetLogsTailInputSchema.parse(normalizeToolArgs(args));
  const requestedRole = resolveLogsTailRole(input);
  return service.tailLogs({
    role: requestedRole,
    agentId: input.agentId,
    tailPerAgent: input.tailPerAgent ?? 100,
    contains: input.contains,
  });
}

async function runWatch(
  target: FleetWatchTarget,
  run: () => Promise<Record<string, unknown> | FleetWatchResult>,
  results: Record<FleetWatchTarget, Record<string, unknown>>,
  notificationToken: string | undefined,
  onEvent?: (event: FleetWatchEvent) => Promise<void>,
): Promise<void> {
  try {
    const result = await run();
    results[target] = {
      eventCount: Number(result.eventCount ?? 0),
      reason: typeof result.reason === "string" ? result.reason : "server_shutdown",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results[target] = {
      eventCount: 0,
      reason: "server_shutdown",
      error: {
        message,
      },
    };
    await emitEvent(onEvent, {
      type: "fleet.watch.error",
      payload: withToken({ target, message }, notificationToken),
    });
  }
}

function relayAbort(signal: AbortSignal | undefined, controller: AbortController): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    controller.abort();
    return;
  }
  signal.addEventListener("abort", () => controller.abort(), { once: true });
}

async function emitEvent(
  emitter: ((event: FleetWatchEvent) => Promise<void>) | undefined,
  event: FleetWatchEvent,
): Promise<void> {
  if (!emitter) {
    return;
  }
  await emitter(event);
}

function withToken(payload: Record<string, unknown>, token: string | undefined): Record<string, unknown> {
  if (!token) {
    return payload;
  }
  return {
    ...payload,
    notificationToken: token,
  };
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
