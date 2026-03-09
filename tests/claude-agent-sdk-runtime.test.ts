import { describe, expect, it } from "vitest";
import { ClaudeAgentSdkRuntime } from "../src/infra/agent-runtime/claude-agent-sdk-runtime.js";
import type { ClaudeAgentSdkClient } from "../src/infra/agent-runtime/claude-agent-sdk-client.js";

class FakeClaudeQuery implements AsyncIterable<{
  type: "system" | "assistant" | "result" | "stream_event" | "tool_use_summary";
  subtype?: string;
  uuid: string;
  session_id: string;
  [key: string]: unknown;
}> {
  public closed = false;

  constructor(
    private readonly messages: Array<{
      type: "system" | "assistant" | "result" | "stream_event" | "tool_use_summary";
      subtype?: string;
      uuid: string;
      session_id: string;
      [key: string]: unknown;
    }>,
  ) {}

  close(): void {
    this.closed = true;
  }

  async *[Symbol.asyncIterator]() {
    for (const message of this.messages) {
      if (this.closed) {
        return;
      }
      yield message;
    }
  }
}

class HangingAfterResultClaudeQuery extends FakeClaudeQuery {
  override async *[Symbol.asyncIterator]() {
    for (const message of [
      { type: "system", subtype: "init", uuid: "msg-init", session_id: "sess-999" },
      { type: "result", subtype: "success", uuid: "msg-result", session_id: "sess-999" },
    ] as const) {
      if (this.closed) {
        return;
      }
      yield message;
    }

    // Simulate an SDK stream that emitted result but never naturally closed.
    while (!this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

class FakeClaudeAgentSdkClient implements ClaudeAgentSdkClient {
  public calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  public lastQuery: FakeClaudeQuery | null = null;

  query(input: { prompt: string; options: Record<string, unknown> }): FakeClaudeQuery {
    this.calls.push(input);
    this.lastQuery = new FakeClaudeQuery([
      { type: "system", subtype: "init", uuid: "msg-init", session_id: "sess-123" },
      { type: "assistant", uuid: "msg-assistant", session_id: "sess-123" },
      { type: "result", subtype: "success", uuid: "msg-result", session_id: "sess-123" },
    ]);
    return this.lastQuery;
  }
}

describe("ClaudeAgentSdkRuntime", () => {
  it("maps Claude query execution into provider-neutral session state", async () => {
    const client = new FakeClaudeAgentSdkClient();
    const runtime = new ClaudeAgentSdkRuntime(client);

    const prepared = await runtime.prepareAgent({
      agentId: "orchestrator-1",
      role: "Orchestrator",
      cwd: "/workspace",
      detached: false,
      startupPrompt: "You are Orchestrator.",
      runtimeConfig: { model: "claude-sonnet-4-5", permissionMode: "acceptEdits", persistSession: false },
    });
    expect(prepared.provider).toBe("claude-agent-sdk");
    expect(prepared.pid).toBeNull();

    const result = await runtime.execute({
      agentId: "orchestrator-1",
      role: "Orchestrator",
      cwd: "/workspace",
      prompt: "Implement this event",
      responseLanguage: "日本語",
      runtimeConfig: {
        model: "claude-sonnet-4-5",
        permissionMode: "acceptEdits",
        allowedTools: ["Bash", "Read"],
        maxTurns: 20,
        persistSession: false,
      },
    });

    expect(client.calls[0]?.prompt).toBe("Implement this event");
    expect(client.calls[0]?.options).toMatchObject({
      cwd: "/workspace",
      model: "claude-sonnet-4-5",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash", "Read"],
      maxTurns: 20,
      includePartialMessages: true,
      settingSources: [],
      tools: { type: "preset", preset: "claude_code" },
    });
    expect(result).toMatchObject({
      provider: "claude-agent-sdk",
      session: {
        conversationId: "sess-123",
        activeInvocationId: "msg-result",
      },
    });
  });

  it("resumes an existing session when persistSession is enabled and shutdown closes in-flight query", async () => {
    const client = new FakeClaudeAgentSdkClient();
    const runtime = new ClaudeAgentSdkRuntime(client);

    const execution = runtime.execute({
      agentId: "orchestrator-1",
      role: "Orchestrator",
      cwd: "/workspace",
      prompt: "Continue work",
      currentSession: {
        conversationId: "sess-existing",
        activeInvocationId: "msg-old",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      },
      runtimeConfig: {
        persistSession: true,
        settingSources: ["project"],
      },
    });

    await runtime.shutdownAgent("orchestrator-1");
    expect(client.lastQuery?.closed).toBe(true);
    await execution;
    expect(client.calls[0]?.options.resume).toBe("sess-existing");
    expect(client.calls[0]?.options.settingSources).toEqual(["project"]);
  });

  it("returns immediately after a terminal result even if the iterator does not close", async () => {
    const client: ClaudeAgentSdkClient = {
      query() {
        return new HangingAfterResultClaudeQuery([]);
      },
    };
    const runtime = new ClaudeAgentSdkRuntime(client);

    const result = await runtime.execute({
      agentId: "reviewer-1",
      role: "Reviewer",
      cwd: "/workspace",
      prompt: "Review the epic",
      runtimeConfig: {},
    });

    expect(result).toMatchObject({
      provider: "claude-agent-sdk",
      session: {
        conversationId: "sess-999",
        activeInvocationId: "msg-result",
      },
    });
  });

  it("emits Claude thinking and tool-use progress when partial messages are enabled", async () => {
    const captured: string[] = [];
    const client: ClaudeAgentSdkClient = {
      query() {
        return new FakeClaudeQuery([
          { type: "system", subtype: "init", uuid: "msg-init", session_id: "sess-123" },
          {
            type: "stream_event",
            uuid: "msg-stream-thinking",
            session_id: "sess-123",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "sig-1" },
            },
          },
          {
            type: "stream_event",
            uuid: "msg-stream-thinking-delta",
            session_id: "sess-123",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "spec を確認する" },
            },
          },
          {
            type: "stream_event",
            uuid: "msg-stream-thinking-stop",
            session_id: "sess-123",
            event: {
              type: "content_block_stop",
              index: 0,
            },
          },
          {
            type: "stream_event",
            uuid: "msg-stream-tool",
            session_id: "sess-123",
            event: {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "tool-1",
                name: "Bash",
                input: {},
              },
            },
          },
          {
            type: "stream_event",
            uuid: "msg-stream-tool-delta",
            session_id: "sess-123",
            event: {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
            },
          },
          {
            type: "stream_event",
            uuid: "msg-stream-tool-stop",
            session_id: "sess-123",
            event: {
              type: "content_block_stop",
              index: 1,
            },
          },
          {
            type: "system",
            subtype: "task_progress",
            uuid: "msg-progress",
            session_id: "sess-123",
            task_id: "task-1",
            description: "running pwd",
            last_tool_name: "Bash",
            usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
          },
          {
            type: "tool_use_summary",
            uuid: "msg-tool-summary",
            session_id: "sess-123",
            summary: "Bash completed successfully",
            preceding_tool_use_ids: ["tool-1"],
          },
          { type: "result", subtype: "success", uuid: "msg-result", session_id: "sess-123" },
        ]);
      },
    };
    const runtime = new ClaudeAgentSdkRuntime(client, (event) => {
      if (event.message) {
        captured.push(event.message);
      }
    });

    await runtime.execute({
      agentId: "curator-1",
      role: "Curator",
      cwd: "/workspace",
      prompt: "Review docs",
      runtimeConfig: {},
    });

    expect(captured).toContain("reasoning: spec を確認する");
    expect(captured).toContain('tool start: Bash input={"command":"pwd"}');
    expect(captured).toContain("tool progress: Bash running pwd");
    expect(captured).toContain("tool end: Bash completed successfully");
  });
});
