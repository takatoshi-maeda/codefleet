import { describe, expect, it } from "vitest";
import {
  formatAgentRuntimeConsoleLog,
  formatAgentRuntimeEventLog,
  formatAgentRuntimeHumanLog,
  shouldSuppressAgentRuntimeEvent,
} from "../src/cli/logging/fleet-agent-event-log.js";
import type { AgentRuntimeEvent } from "../src/domain/fleet/role-agent-runtime.js";

function codexNativeEvent(nativeType: string, payload?: Record<string, unknown>): AgentRuntimeEvent {
  return {
    agentId: "developer-1",
    provider: "codex-app-server",
    occurredAt: "2026-03-05T10:00:00.000Z",
    kind: "native",
    nativeType,
    payload,
  };
}

describe("fleet agent event log formatting", () => {
  it("suppresses high-volume native event types", () => {
    expect(
      shouldSuppressAgentRuntimeEvent(
        codexNativeEvent("item/agentMessage/delta", {
          delta: "partial",
        }),
      ),
    ).toBe(true);
    expect(shouldSuppressAgentRuntimeEvent(codexNativeEvent("codex/event/agent_message_delta"))).toBe(true);
    expect(shouldSuppressAgentRuntimeEvent(codexNativeEvent("turn/started"))).toBe(false);
  });

  it("summarizes approval request events with compact command details", () => {
    const record = formatAgentRuntimeEventLog(
      codexNativeEvent("codex/event/exec_approval_request", {
        msg: {
          command: [
            "/bin/zsh",
            "-lc",
            "codefleet-acceptance-test add --title \"Auth: Sign up with email/password\"",
          ],
          cwd: "/tmp/sandbox/todoapp",
          reason: "Do you want to allow writing acceptance test definitions to the local Codefleet data store for this task?",
        },
      }),
    );

    expect(record.summary).toContain("codex/event/exec_approval_request");
    expect(record.payload).toEqual({
      command: ["/bin/zsh", "-lc", "codefleet-acceptance-test add --title \"Auth: Sign up with email/password\""],
      cwd: "/tmp/sandbox/todoapp",
      reason: "Do you want to allow writing acceptance test definitions to the local Codefleet data store for this task?",
    });
  });

  it("truncates oversized payload fields so each line remains readable", () => {
    const longText = "x".repeat(600);
    const record = formatAgentRuntimeEventLog(
      codexNativeEvent("thread/started", {
        thread: {
          id: "019c50b9-b581-72c3-8cdc-1a171e860020",
          preview: longText,
        },
      }),
    );

    expect(record.summary).toBe("conversation started: 019c50b9-b581-72c3-8cdc-1a171e860020");
    expect(record.payload).toEqual({
      thread: {
        id: "019c50b9-b581-72c3-8cdc-1a171e860020",
        preview: expect.stringContaining("[truncated "),
      },
    });
  });

  it("emits human-readable logs for assistant, reasoning, and tool events", () => {
    expect(
      formatAgentRuntimeHumanLog({
        agentId: "gatekeeper-1",
        provider: "codex-app-server",
        occurredAt: "2026-02-12T08:16:42.046Z",
        kind: "tool_started",
        message: "tool start: /bin/zsh -lc pwd && ls -la (cwd: /tmp/sandbox/todoapp)",
      }),
    ).toEqual({
      ts: "2026-02-12T08:16:42.046Z",
      level: "info",
      agentId: "gatekeeper-1",
      message: "tool start: /bin/zsh -lc pwd && ls -la (cwd: /tmp/sandbox/todoapp)",
    });

    expect(
      formatAgentRuntimeHumanLog({
        agentId: "gatekeeper-1",
        provider: "codex-app-server",
        occurredAt: "2026-02-12T08:17:18.746Z",
        kind: "assistant_message",
        message: "assistant: 中間報告です。",
      }),
    ).toEqual({
      ts: "2026-02-12T08:17:18.746Z",
      level: "info",
      agentId: "gatekeeper-1",
      message: "assistant: 中間報告です。",
    });

    expect(
      formatAgentRuntimeHumanLog({
        agentId: "gatekeeper-1",
        provider: "codex-app-server",
        occurredAt: "2026-02-12T08:16:41.895Z",
        kind: "reasoning",
        message: "reasoning: **Preparing repo inspection commands**",
      }),
    ).toEqual({
      ts: "2026-02-12T08:16:41.895Z",
      level: "info",
      agentId: "gatekeeper-1",
      message: "reasoning: **Preparing repo inspection commands**",
    });
  });

  it("emits console logs only for allowed human-readable messages", () => {
    expect(
      formatAgentRuntimeConsoleLog({
        agentId: "developer-1",
        provider: "codex-app-server",
        occurredAt: "2026-03-05T10:00:01.000Z",
        kind: "reasoning",
        message: "reasoning: <empty>",
      }),
    ).toEqual({
      ts: "2026-03-05T10:00:01.000Z",
      level: "info",
      event: "fleet.agent.output",
      agentId: "developer-1",
      message: "reasoning: <empty>",
    });

    expect(
      formatAgentRuntimeConsoleLog({
        agentId: "developer-1",
        provider: "codex-app-server",
        occurredAt: "2026-03-05T10:00:02.000Z",
        kind: "assistant_message",
        message: "assistant: final answer",
      }),
    ).toEqual({
      ts: "2026-03-05T10:00:02.000Z",
      level: "info",
      event: "fleet.agent.output",
      agentId: "developer-1",
      message: "assistant: final answer",
    });

    expect(formatAgentRuntimeConsoleLog(codexNativeEvent("codex/event/task_started", { msg: { type: "task_started" } }))).toBeNull();
  });

  it("supports provider-common logs for Claude events", () => {
    const consoleLog = formatAgentRuntimeConsoleLog({
      agentId: "orchestrator-1",
      provider: "claude-agent-sdk",
      occurredAt: "2026-03-06T00:00:00.000Z",
      kind: "assistant_message",
      message: "assistant: Claude response",
      nativeType: "assistant",
    });

    expect(consoleLog).toEqual({
      ts: "2026-03-06T00:00:00.000Z",
      level: "info",
      event: "fleet.agent.output",
      agentId: "orchestrator-1",
      message: "assistant: Claude response",
    });

    const eventLog = formatAgentRuntimeEventLog({
      agentId: "orchestrator-1",
      provider: "claude-agent-sdk",
      occurredAt: "2026-03-06T00:00:01.000Z",
      kind: "invocation_finished",
      message: "invocation finished",
      nativeType: "result/success",
      payload: {
        subtype: "success",
      },
    });

    expect(eventLog).toMatchObject({
      provider: "claude-agent-sdk",
      kind: "invocation_finished",
      nativeType: "result/success",
      summary: "invocation finished",
    });
  });
});
