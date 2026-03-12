import type { AgentMount } from "ai-kit/hono";
import type { BacklogService } from "../../../domain/backlog/backlog-service.js";
import {
  executeBacklogTool,
  listBacklogToolDefinitions,
  normalizeToolArgs,
  type BacklogToolName,
} from "../../../application/tools/backlog-tools.js";
import type { McpToolAuditLogEntry, McpToolAuditLogger } from "./mcp-tool-audit-log.js";

interface RegisterBacklogMcpToolsOptions {
  agentName?: string;
  logger?: McpToolAuditLogger;
}

export function registerBacklogMcpTools(
  mount: AgentMount,
  service: BacklogService,
  options: RegisterBacklogMcpToolsOptions = {},
): void {
  const agentName = options.agentName ?? "codefleet";
  for (const definition of listBacklogToolDefinitions()) {
    mount.mcpServer.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.mcpInputSchema,
      },
      async (args) =>
        executeTool({
          toolName: definition.name,
          args,
          agentName,
          logger: options.logger,
          run: async () =>
            executeBacklogTool(service, definition.name, args),
        }),
    );
  }
}

async function executeTool(input: {
  toolName: BacklogToolName;
  args: unknown;
  agentName: string;
  logger?: McpToolAuditLogger;
  run: () => Promise<{ isError: boolean; payload: Record<string, unknown> }>;
}) {
  const startedAt = Date.now();
  const normalizedArgs = normalizeToolArgs(input.args);

  try {
    const result = await input.run();
    const response = toMcpToolResponse(result);
    const maybeError = readErrorPayload(result.payload);
    await writeAuditLog(input.logger, {
      ts: new Date().toISOString(),
      agent: input.agentName,
      tool: input.toolName,
      input: normalizedArgs,
      durationMs: Date.now() - startedAt,
      isError: result.isError,
      ...(typeof result.payload.count === "number" ? { resultCount: result.payload.count } : {}),
      ...(typeof maybeError?.code === "string" ? { errorCode: maybeError.code } : {}),
      ...(typeof maybeError?.message === "string" ? { errorMessage: maybeError.message } : {}),
    });
    return response;
  } catch (error) {
    const payload = {
      error: {
        code: "ERR_UNEXPECTED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    const mapped = {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
    await writeAuditLog(input.logger, {
      ts: new Date().toISOString(),
      agent: input.agentName,
      tool: input.toolName,
      input: normalizedArgs,
      durationMs: Date.now() - startedAt,
      isError: true,
      errorCode: payload.error.code,
      errorMessage: payload.error.message,
    });
    return mapped;
  }
}

async function writeAuditLog(logger: McpToolAuditLogger | undefined, entry: McpToolAuditLogEntry): Promise<void> {
  if (!logger) {
    return;
  }

  try {
    await logger.log(entry);
  } catch (error) {
    // Logging failures must not break tool execution.
    console.warn(
      `[codefleet:mcp] failed to write backlog tool audit log: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toMcpToolResponse(result: { isError: boolean; payload: Record<string, unknown> }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.payload, null, 2) }],
    structuredContent: result.payload,
    isError: result.isError,
  };
}

function readErrorPayload(payload: Record<string, unknown>): { code?: unknown; message?: unknown } | undefined {
  const maybeError = payload.error;
  if (!maybeError || typeof maybeError !== "object" || Array.isArray(maybeError)) {
    return undefined;
  }
  const parsed = maybeError as { code?: unknown; message?: unknown };
  return parsed;
}
