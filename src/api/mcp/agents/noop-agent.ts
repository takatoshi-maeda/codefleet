import type { AgentContext, AgentResult } from "../../../../vendor/ai-kit/src/types/agent.js";
import type { LLMStreamEvent } from "../../../../vendor/ai-kit/src/types/stream-events.js";

export class NoopFrontDeskAgent {
  constructor(private readonly context: AgentContext) {}

  async invoke(_input: string): Promise<AgentResult> {
    const text = "codefleet.front-desk is ready.";
    await this.context.history.addMessage({ role: "assistant", content: text });
    return {
      content: text,
      toolCalls: [],
      usage: emptyUsage(),
      responseId: null,
      raw: {
        type: "message",
        content: text,
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
