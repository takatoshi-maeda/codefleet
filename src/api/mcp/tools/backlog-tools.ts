import { z } from "zod";
import type { AgentMount } from "../../../../vendor/ai-kit/src/hono/index.js";
import type { BacklogService } from "../../../domain/backlog/backlog-service.js";
import { CodefleetError } from "../../../shared/errors.js";

const BacklogEpicStatusSchema = z.enum(["todo", "in-progress", "in-review", "changes-requested", "done", "blocked", "failed"]);
const BacklogItemStatusSchema = z.enum(["todo", "wait-implementation", "in-progress", "done", "blocked"]);
const BacklogWorkKindSchema = z.enum(["product", "technical"]);

const BacklogEpicListInputSchema = z.object({
  status: BacklogEpicStatusSchema.optional(),
  kind: BacklogWorkKindSchema.optional(),
  includeHidden: z.boolean().optional(),
  actorId: z.string().optional(),
});

const BacklogEpicGetInputSchema = z.object({
  id: z.string().min(1),
});
const BacklogEpicGetMcpInputSchema = z.object({
  id: z.string().optional(),
});

const BacklogItemListInputSchema = z.object({
  epicId: z.string().optional(),
  status: BacklogItemStatusSchema.optional(),
  kind: BacklogWorkKindSchema.optional(),
  includeHidden: z.boolean().optional(),
  actorId: z.string().optional(),
});

const BacklogItemGetInputSchema = z.object({
  id: z.string().min(1),
});
const BacklogItemGetMcpInputSchema = z.object({
  id: z.string().optional(),
});

export function registerBacklogMcpTools(mount: AgentMount, service: BacklogService): void {
  mount.mcpServer.registerTool(
    "backlog.epic.list",
    {
      description: "List backlog epics",
      inputSchema: BacklogEpicListInputSchema.shape,
    },
    async (args) => {
      try {
        const input = BacklogEpicListInputSchema.parse(normalizeToolArgs(args));
        const listed = await service.list(input);
        const payload = {
          epics: listed.epics,
          count: listed.epics.length,
          updatedAt: listed.updatedAt,
        };
        return success(payload);
      } catch (error) {
        return mapToolError(error);
      }
    },
  );

  mount.mcpServer.registerTool(
    "backlog.epic.get",
    {
      description: "Get a backlog epic by id",
      inputSchema: BacklogEpicGetMcpInputSchema.shape,
    },
    async (args) => {
      try {
        const input = BacklogEpicGetInputSchema.parse(normalizeToolArgs(args));
        const payload = { epic: await service.readEpic(input) };
        return success(payload);
      } catch (error) {
        return mapToolError(error);
      }
    },
  );

  mount.mcpServer.registerTool(
    "backlog.item.list",
    {
      description: "List backlog items",
      inputSchema: BacklogItemListInputSchema.shape,
    },
    async (args) => {
      try {
        const input = BacklogItemListInputSchema.parse(normalizeToolArgs(args));
        const listed = await service.list(input);
        const payload = {
          items: listed.items,
          count: listed.items.length,
          updatedAt: listed.updatedAt,
        };
        return success(payload);
      } catch (error) {
        return mapToolError(error);
      }
    },
  );

  mount.mcpServer.registerTool(
    "backlog.item.get",
    {
      description: "Get a backlog item by id",
      inputSchema: BacklogItemGetMcpInputSchema.shape,
    },
    async (args) => {
      try {
        const input = BacklogItemGetInputSchema.parse(normalizeToolArgs(args));
        const payload = { item: await service.readItem(input) };
        return success(payload);
      } catch (error) {
        return mapToolError(error);
      }
    },
  );
}

function success(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

function mapToolError(error: unknown) {
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
