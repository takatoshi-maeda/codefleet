import { z } from "zod";
import type { BacklogService } from "../../domain/backlog/backlog-service.js";
import type { BacklogEpic } from "../../domain/backlog-items-model.js";
import {
  BacklogObservabilityService,
  type BacklogWatchEvent,
} from "../../domain/backlog/backlog-observability-service.js";
import { CodefleetError, type ErrorCode } from "../../shared/errors.js";
import { normalizeToolArgs } from "./tool-args.js";

// Tool definitions live in the application layer so MCP/CLI adapters can reuse
// one validation and error-mapping policy without duplicating domain calls.
export const BacklogEpicStatusSchema = z.enum([
  "todo",
  "in-progress",
  "in-review",
  "changes-requested",
  "done",
  "blocked",
  "failed",
]);
export const BacklogItemStatusSchema = z.enum([
  "todo",
  "wait-implementation",
  "in-progress",
  "done",
  "blocked",
]);
export const BacklogWorkKindSchema = z.enum(["product", "technical"]);

export const BacklogEpicListInputSchema = z.object({
  status: BacklogEpicStatusSchema.optional(),
  kind: BacklogWorkKindSchema.optional(),
  includeHidden: z.boolean().optional(),
  actorId: z.string().optional(),
});

export const BacklogEpicGetInputSchema = z.object({
  id: z.string().min(1),
});
export const BacklogEpicGetMcpInputSchema = z.object({
  id: z.string().optional(),
});

export const BacklogItemListInputSchema = z.object({
  epicId: z.string().optional(),
  status: BacklogItemStatusSchema.optional(),
  kind: BacklogWorkKindSchema.optional(),
  includeHidden: z.boolean().optional(),
  actorId: z.string().optional(),
});

export const BacklogItemGetInputSchema = z.object({
  id: z.string().min(1),
});
export const BacklogItemGetMcpInputSchema = z.object({
  id: z.string().optional(),
});

export const BacklogWatchInputSchema = z.object({
  includeSnapshot: z.boolean().optional(),
  heartbeatSec: z.number().int().min(5).max(60).optional(),
  maxDurationSec: z.number().int().min(1).max(1800).optional(),
  notificationToken: z.string().min(1).optional(),
});

export type BacklogToolName =
  | "backlog.epic.list"
  | "backlog.epic.get"
  | "backlog.item.list"
  | "backlog.item.get";

export interface ExecuteBacklogToolOptions {
  onWatchEvent?: (event: BacklogWatchEvent) => Promise<void>;
  signal?: AbortSignal;
}

export interface BacklogToolSuccess {
  isError: false;
  payload: Record<string, unknown>;
}

export interface BacklogToolFailure {
  isError: true;
  payload: {
    error: {
      code: ErrorCode;
      message: string;
    };
  };
}

export type BacklogToolResult = BacklogToolSuccess | BacklogToolFailure;

export interface BacklogToolDefinition {
  name: BacklogToolName;
  description: string;
  // MCP input schemas are intentionally permissive for *.get and delegate
  // required-field errors to shared validation/error normalization below.
  mcpInputSchema: Record<string, z.ZodTypeAny>;
  parameters: z.ZodTypeAny;
  run: (
    service: BacklogService,
    rawArgs: unknown,
    options: ExecuteBacklogToolOptions,
  ) => Promise<Record<string, unknown>>;
}

interface EpicVisibilityState {
  isVisible: boolean;
  invisibilityReason: "blocked-by-incomplete-epic" | null;
  blockedByIncompleteEpicIds: string[];
}

const BACKLOG_TOOL_DEFINITIONS: BacklogToolDefinition[] = [
  {
    name: "backlog.epic.list",
    description: "List backlog epics",
    mcpInputSchema: BacklogEpicListInputSchema.shape,
    parameters: BacklogEpicListInputSchema,
    run: async (service, rawArgs) => {
      const input = BacklogEpicListInputSchema.parse(normalizeToolArgs(rawArgs));
      // CLI keeps hidden epics included by default unless visible-only is requested.
      // Mirror that default here so API and CLI return the same baseline dataset.
      const listInput = { ...input, includeHidden: input.includeHidden ?? true };
      const [listed, fullSnapshot] = await Promise.all([service.list(listInput), service.list({ includeHidden: true })]);
      const fullEpicsById = new Map(fullSnapshot.epics.map((epic) => [epic.id, epic]));
      return {
        epics: listed.epics.map((epic) => enrichEpicWithVisibilityState(epic, fullEpicsById)),
        count: listed.epics.length,
        updatedAt: listed.updatedAt,
      };
    },
  },
  {
    name: "backlog.epic.get",
    description: "Get a backlog epic by id",
    mcpInputSchema: BacklogEpicGetMcpInputSchema.shape,
    parameters: BacklogEpicGetInputSchema,
    run: async (service, rawArgs) => {
      const input = BacklogEpicGetInputSchema.parse(normalizeToolArgs(rawArgs));
      const [epic, fullSnapshot] = await Promise.all([service.readEpic(input), service.list({ includeHidden: true })]);
      const fullEpicsById = new Map(fullSnapshot.epics.map((value) => [value.id, value]));
      return { epic: enrichEpicWithVisibilityState(epic, fullEpicsById) };
    },
  },
  {
    name: "backlog.item.list",
    description: "List backlog items",
    mcpInputSchema: BacklogItemListInputSchema.shape,
    parameters: BacklogItemListInputSchema,
    run: async (service, rawArgs) => {
      const input = BacklogItemListInputSchema.parse(normalizeToolArgs(rawArgs));
      // Keep API default aligned with CLI item list behavior.
      const listed = await service.list({ ...input, includeHidden: input.includeHidden ?? true });
      return {
        items: listed.items,
        count: listed.items.length,
        updatedAt: listed.updatedAt,
      };
    },
  },
  {
    name: "backlog.item.get",
    description: "Get a backlog item by id",
    mcpInputSchema: BacklogItemGetMcpInputSchema.shape,
    parameters: BacklogItemGetInputSchema,
    run: async (service, rawArgs) => {
      const input = BacklogItemGetInputSchema.parse(normalizeToolArgs(rawArgs));
      return { item: await service.readItem(input) };
    },
  },
];

const TOOL_DEFINITION_MAP = new Map<BacklogToolName, BacklogToolDefinition>(
  BACKLOG_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);

export function listBacklogToolDefinitions(): readonly BacklogToolDefinition[] {
  return BACKLOG_TOOL_DEFINITIONS;
}

export function getBacklogToolDefinition(name: BacklogToolName): BacklogToolDefinition {
  const definition = TOOL_DEFINITION_MAP.get(name);
  if (!definition) {
    throw new Error(`backlog tool definition not found: ${name}`);
  }
  return definition;
}

export async function executeBacklogTool(
  service: BacklogService,
  toolName: BacklogToolName,
  args: unknown,
  options: ExecuteBacklogToolOptions = {},
): Promise<BacklogToolResult> {
  const definition = getBacklogToolDefinition(toolName);
  try {
    const payload = await definition.run(service, args, options);
    return { isError: false, payload };
  } catch (error) {
    return { isError: true, payload: mapToolError(error) };
  }
}

export async function executeBacklogWatchTool(
  service: BacklogService,
  args: unknown,
  onEvent?: (event: BacklogWatchEvent) => Promise<void>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const input = BacklogWatchInputSchema.parse(normalizeToolArgs(args));
  const observability = new BacklogObservabilityService(service, service.getBacklogDir());
  const result = await observability.watchBacklog({
    includeSnapshot: input.includeSnapshot ?? true,
    heartbeatSec: input.heartbeatSec ?? 15,
    maxDurationSec: input.maxDurationSec,
    notificationToken: input.notificationToken,
    signal,
    onEvent,
  });
  return {
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    eventCount: result.eventCount,
    reason: result.reason,
  };
}

function mapToolError(error: unknown): BacklogToolFailure["payload"] {
  if (error instanceof CodefleetError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  if (error instanceof z.ZodError) {
    return {
      error: {
        code: "ERR_VALIDATION",
        message: error.issues.map((issue) => issue.message).join("; "),
      },
    };
  }

  return {
    error: {
      code: "ERR_UNEXPECTED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export { normalizeToolArgs };
export type { BacklogWatchEvent };

function enrichEpicWithVisibilityState(
  epic: BacklogEpic,
  epicsById: ReadonlyMap<string, BacklogEpic>,
): BacklogEpic & { visibilityState: EpicVisibilityState } {
  return {
    ...epic,
    visibilityState: resolveEpicVisibilityState(epic, epicsById),
  };
}

function resolveEpicVisibilityState(epic: BacklogEpic, epicsById: ReadonlyMap<string, BacklogEpic>): EpicVisibilityState {
  if (epic.visibility.type !== "blocked-until-epic-complete") {
    return {
      isVisible: true,
      invisibilityReason: null,
      blockedByIncompleteEpicIds: [],
    };
  }

  // Dependency ids that are missing or not done are treated as incomplete.
  const blockedByIncompleteEpicIds = epic.visibility.dependsOnEpicIds.filter((id) => epicsById.get(id)?.status !== "done");
  const isVisible = blockedByIncompleteEpicIds.length === 0;
  return {
    isVisible,
    invisibilityReason: isVisible ? null : "blocked-by-incomplete-epic",
    blockedByIncompleteEpicIds,
  };
}
