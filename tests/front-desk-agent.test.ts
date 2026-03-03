import { describe, expect, it, vi } from "vitest";
import { AgentContextImpl, InMemoryHistory } from "ai-kit";
import type { LLMClient, LLMChatInput } from "ai-kit";
import { createCodefleetFrontDeskAgent, resolveCodefleetFrontDeskRuntimeConfig } from "../src/agents/front-desk.js";
import type { BacklogService } from "../src/domain/backlog/backlog-service.js";

describe("codefleet front-desk agent", () => {
  it("fails fast when api key is unresolved", () => {
    expect(() =>
      resolveCodefleetFrontDeskRuntimeConfig({
        llm: {
          provider: "openai",
          model: "gpt-5.3-codex",
          apiKeyEnv: "CODEFLEET_TEST_MISSING_KEY",
        },
      })
    ).toThrow(/CODEFLEET_TEST_MISSING_KEY/);
  });

  it("uses shared backlog tools in llm agent flow", async () => {
    const backlogService = {
      list: vi.fn(async () => ({
        epics: [],
        items: [],
        questions: [],
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      readEpic: vi.fn(async () => ({ id: "E-001", title: "epic" })),
      readItem: vi.fn(async () => ({ id: "I-001", title: "item" })),
    } as unknown as BacklogService;

    let streamCallCount = 0;
    const mockClient: LLMClient = {
      provider: "openai",
      model: "mock-front-desk",
      capabilities: {
        supportsReasoning: true,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsImages: false,
        contextWindowSize: 8_000,
      },
      estimateTokens: () => 0,
      invoke: async () => {
        throw new Error("invoke should not be called in this test");
      },
      stream: async function* (_input: LLMChatInput) {
        streamCallCount += 1;
        if (streamCallCount === 1) {
          yield {
            type: "response.completed",
            result: {
              type: "tool_use",
              content: null,
              toolCalls: [
                {
                  id: "tc-1",
                  name: "backlog_item_get",
                  arguments: { id: "I-001" },
                },
              ],
              usage: emptyUsage(),
              responseId: "resp-1",
              finishReason: "tool_use",
            },
          };
          return;
        }
        yield {
          type: "response.completed",
          result: {
            type: "message",
            content: "I-001 を確認しました。",
            toolCalls: [],
            usage: emptyUsage(),
            responseId: "resp-2",
            finishReason: "stop",
          },
        };
      },
    };

    const createAgent = createCodefleetFrontDeskAgent(backlogService, {
      llm: { provider: "openai", model: "gpt-5.3-codex", apiKey: "test-key" },
      clientFactory: () => mockClient,
      maxTurns: 4,
    });

    const agent = createAgent(new AgentContextImpl({ history: new InMemoryHistory() }));
    const result = await agent.invoke("I-001 を見せて");

    expect(result.content).toContain("I-001");
    expect(backlogService.readItem).toHaveBeenCalledWith({ id: "I-001" });
    expect(streamCallCount).toBe(2);
  });
});

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
