import { z } from "zod";
import type { BacklogService } from "../../domain/backlog/backlog-service.js";
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

export type BacklogToolName =
  | "backlog.epic.list"
  | "backlog.epic.get"
  | "backlog.item.list"
  | "backlog.item.get";

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
  run: (service: BacklogService, rawArgs: unknown) => Promise<Record<string, unknown>>;
}

const BACKLOG_TOOL_DEFINITIONS: BacklogToolDefinition[] = [
  {
    name: "backlog.epic.list",
    description: "List backlog epics",
    mcpInputSchema: BacklogEpicListInputSchema.shape,
    parameters: BacklogEpicListInputSchema,
    run: async (service, rawArgs) => {
      const input = BacklogEpicListInputSchema.parse(normalizeToolArgs(rawArgs));
      const listed = await service.list(input);
      return {
        epics: listed.epics,
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
      return { epic: await service.readEpic(input) };
    },
  },
  {
    name: "backlog.item.list",
    description: "List backlog items",
    mcpInputSchema: BacklogItemListInputSchema.shape,
    parameters: BacklogItemListInputSchema,
    run: async (service, rawArgs) => {
      const input = BacklogItemListInputSchema.parse(normalizeToolArgs(rawArgs));
      const listed = await service.list(input);
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
): Promise<BacklogToolResult> {
  const definition = getBacklogToolDefinition(toolName);
  try {
    const payload = await definition.run(service, args);
    return { isError: false, payload };
  } catch (error) {
    return { isError: true, payload: mapToolError(error) };
  }
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
