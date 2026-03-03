import { z } from "zod";
import type { ToolDefinition } from "ai-kit";
import type { BacklogService } from "../../domain/backlog/backlog-service.js";
import {
  BacklogEpicGetInputSchema,
  BacklogEpicListInputSchema,
  BacklogItemGetInputSchema,
  BacklogItemListInputSchema,
  executeBacklogTool,
  type BacklogToolName,
} from "../../application/tools/backlog-tools.js";

type BacklogAgentToolName =
  | "backlog_epic_list"
  | "backlog_epic_get"
  | "backlog_item_list"
  | "backlog_item_get";

const BACKLOG_AGENT_TOOL_MAPPINGS: ReadonlyArray<{
  agentToolName: BacklogAgentToolName;
  canonicalToolName: BacklogToolName;
  description: string;
  parameters: z.ZodTypeAny;
}> = [
  {
    agentToolName: "backlog_epic_list",
    canonicalToolName: "backlog.epic.list",
    description: "List backlog epics",
    parameters: BacklogEpicListInputSchema,
  },
  {
    agentToolName: "backlog_epic_get",
    canonicalToolName: "backlog.epic.get",
    description: "Get a backlog epic by id",
    parameters: BacklogEpicGetInputSchema,
  },
  {
    agentToolName: "backlog_item_list",
    canonicalToolName: "backlog.item.list",
    description: "List backlog items",
    parameters: BacklogItemListInputSchema,
  },
  {
    agentToolName: "backlog_item_get",
    canonicalToolName: "backlog.item.get",
    description: "Get a backlog item by id",
    parameters: BacklogItemGetInputSchema,
  },
];

export function createBacklogAgentTools(service: BacklogService): ToolDefinition[] {
  return BACKLOG_AGENT_TOOL_MAPPINGS.map((mapping) => ({
    name: mapping.agentToolName,
    description: mapping.description,
    parameters: mapping.parameters,
    execute: async (params) => {
      const result = await executeBacklogTool(service, mapping.canonicalToolName, params);
      return result.payload;
    },
  }));
}

export function createBacklogAgentToolMap(service: BacklogService): Map<BacklogAgentToolName, ToolDefinition> {
  const tools = createBacklogAgentTools(service);
  return new Map(
    tools
      .filter(isBacklogToolDefinition)
      .map((tool) => [tool.name, tool]),
  );
}

function isBacklogToolDefinition(
  tool: ToolDefinition,
): tool is ToolDefinition<z.ZodTypeAny> & { name: BacklogAgentToolName } {
  return (
    tool.name === "backlog_epic_list" ||
    tool.name === "backlog_epic_get" ||
    tool.name === "backlog_item_list" ||
    tool.name === "backlog_item_get"
  );
}
