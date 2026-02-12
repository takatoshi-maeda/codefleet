import { describe, expect, it } from "vitest";
import {
  formatAgentEventHumanLog,
  formatAgentEventNotificationLog,
  shouldSuppressNotificationMethod,
} from "../src/cli/logging/fleet-agent-event-log.js";

describe("fleet agent event log formatting", () => {
  it("suppresses high-volume delta and duplicate notification methods", () => {
    expect(shouldSuppressNotificationMethod("item/agentMessage/delta")).toBe(true);
    expect(shouldSuppressNotificationMethod("codex/event/agent_message_delta")).toBe(true);
    expect(shouldSuppressNotificationMethod("turn/started")).toBe(false);
  });

  it("summarizes approval request notifications with compact command details", () => {
    const record = formatAgentEventNotificationLog({
      agentId: "gatekeeper-1",
      method: "codex/event/exec_approval_request",
      receivedAt: "2026-02-12T07:21:50.566Z",
      params: {
        msg: {
          command: [
            "/bin/zsh",
            "-lc",
            "codefleet-acceptance-test add --title \"Auth: Sign up with email/password\"",
          ],
          cwd: "/tmp/sandbox/todoapp",
          reason: "Do you want to allow writing acceptance test definitions to the local Codefleet data store for this task?",
        },
      },
    });

    expect(record.summary).toContain("approval requested");
    expect(record.params).toEqual({
      command: ["/bin/zsh", "-lc", "codefleet-acceptance-test add --title \"Auth: Sign up with email/password\""],
      cwd: "/tmp/sandbox/todoapp",
      reason: "Do you want to allow writing acceptance test definitions to the local Codefleet data store for this task?",
    });
  });

  it("truncates oversized payload fields so each line remains readable", () => {
    const longText = "x".repeat(600);
    const record = formatAgentEventNotificationLog({
      agentId: "gatekeeper-1",
      method: "thread/started",
      receivedAt: "2026-02-12T07:21:13.892Z",
      params: {
        thread: {
          id: "019c50b9-b581-72c3-8cdc-1a171e860020",
          preview: longText,
        },
      },
    });

    expect(record.summary).toBe("thread started: 019c50b9-b581-72c3-8cdc-1a171e860020");
    expect(record.params).toEqual({
      thread: {
        id: "019c50b9-b581-72c3-8cdc-1a171e860020",
        preview: expect.stringContaining("[truncated "),
      },
    });
  });

  it("emits human-readable assistant output only when the part is completed", () => {
    const deltaLog = formatAgentEventHumanLog({
      agentId: "developer-1",
      method: "item/agentMessage/delta",
      receivedAt: "2026-02-12T07:21:44.084Z",
      params: { delta: "hello" },
    });
    expect(deltaLog).toBeNull();

    const completedLog = formatAgentEventHumanLog({
      agentId: "developer-1",
      method: "item/completed",
      receivedAt: "2026-02-12T07:21:50.124Z",
      params: {
        item: {
          type: "agentMessage",
          id: "msg-1",
          text: "line1\nline2",
        },
      },
    });

    expect(completedLog).toEqual({
      ts: "2026-02-12T07:21:50.124Z",
      level: "info",
      agentId: "developer-1",
      message: "assistant: line1\nline2",
    });
  });
});
