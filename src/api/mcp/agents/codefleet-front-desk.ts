import type { AgentContext, AgentResult } from "../../../../vendor/ai-kit/src/types/agent.js";
import type { LLMStreamEvent } from "../../../../vendor/ai-kit/src/types/stream-events.js";
import type { BacklogService } from "../../../domain/backlog/backlog-service.js";
import { CodefleetError } from "../../../shared/errors.js";

interface FrontDeskToolResult {
  toolName: "backlog.epic.list" | "backlog.epic.get" | "backlog.item.list" | "backlog.item.get";
  payload: Record<string, unknown>;
}

export const CODEFLEET_FRONT_DESK_SYSTEM_PROMPT = [
  "You are codefleet.front-desk, a read-only support desk for backlog visibility.",
  "Use backlog.* tools only. Never invent missing details.",
  "If an Epic ID or Item ID is explicitly specified, prefer *.get tools.",
  "If the user asks for lists, filters, or overviews, prefer *.list tools.",
  "If no data is found, clearly say that nothing was detected.",
].join("\n");

export function createCodefleetFrontDeskAgent(backlogService: BacklogService) {
  return (context: AgentContext) => new CodefleetFrontDeskAgent(context, backlogService) as never;
}

class CodefleetFrontDeskAgent {
  constructor(
    private readonly context: AgentContext,
    private readonly backlogService: BacklogService,
  ) {}

  async invoke(input: string): Promise<AgentResult> {
    const result = await this.resolveInput(input);
    const message = formatResultMessage(result);
    await this.context.history.addMessage({ role: "assistant", content: message });
    return {
      content: message,
      toolCalls: [],
      usage: emptyUsage(),
      responseId: null,
      raw: {
        type: "message",
        content: message,
        toolCalls: [],
        usage: emptyUsage(),
        responseId: null,
        finishReason: "stop",
      },
    };
  }

  stream(input: string): AsyncIterable<LLMStreamEvent> & { result: Promise<AgentResult> } {
    const result = this.invoke(input);
    const iterator = (async function* (promise: Promise<AgentResult>): AsyncGenerator<LLMStreamEvent> {
      const resolved = await promise;
      yield {
        type: "response.completed",
        result: resolved.raw,
      };
      return resolved;
    })(result);
    return {
      [Symbol.asyncIterator]: () => iterator,
      result,
    };
  }

  private async resolveInput(input: string): Promise<FrontDeskToolResult | { error: CodefleetError | Error }> {
    try {
      const itemId = extractId(input, /\bI-\d{3,}\b/iu);
      if (itemId) {
        return {
          toolName: "backlog.item.get",
          payload: { item: await this.backlogService.readItem({ id: itemId }) },
        };
      }

      const epicId = extractId(input, /\bE-\d{3,}\b/iu);
      if (epicId) {
        return {
          toolName: "backlog.epic.get",
          payload: { epic: await this.backlogService.readEpic({ id: epicId }) },
        };
      }

      if (isItemIntent(input)) {
        const listed = await this.backlogService.list();
        return {
          toolName: "backlog.item.list",
          payload: {
            items: listed.items,
            count: listed.items.length,
            updatedAt: listed.updatedAt,
          },
        };
      }

      const listed = await this.backlogService.list();
      return {
        toolName: "backlog.epic.list",
        payload: {
          epics: listed.epics,
          count: listed.epics.length,
          updatedAt: listed.updatedAt,
        },
      };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

function formatResultMessage(result: FrontDeskToolResult | { error: CodefleetError | Error }): string {
  if ("error" in result) {
    const maybeCodefleetError = result.error instanceof CodefleetError ? result.error : null;
    if (maybeCodefleetError) {
      return [
        `tool: error (${maybeCodefleetError.code})`,
        `message: ${maybeCodefleetError.message}`,
      ].join("\n");
    }
    return `tool: error (ERR_UNEXPECTED)\nmessage: ${result.error.message}`;
  }

  const payload = result.payload;
  if ("count" in payload && typeof payload.count === "number" && payload.count === 0) {
    return `tool: ${result.toolName}\n該当データは未検出です。追加条件があれば指定してください。`;
  }

  if ("epic" in payload) {
    return `tool: ${result.toolName}\nEpic ${String((payload.epic as { id?: string }).id ?? "unknown")} を取得しました。`;
  }
  if ("item" in payload) {
    return `tool: ${result.toolName}\nItem ${String((payload.item as { id?: string }).id ?? "unknown")} を取得しました。`;
  }
  if ("count" in payload && typeof payload.count === "number") {
    return `tool: ${result.toolName}\n${payload.count} 件を取得しました。`;
  }
  return `tool: ${result.toolName}\n処理が完了しました。`;
}

function extractId(input: string, pattern: RegExp): string | null {
  const matched = input.match(pattern);
  return matched?.[0]?.toUpperCase() ?? null;
}

function isItemIntent(input: string): boolean {
  const normalized = input.toLowerCase();
  return (
    normalized.includes("item") ||
    normalized.includes("items") ||
    input.includes("項目") ||
    input.includes("タスク")
  );
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
  };
}
