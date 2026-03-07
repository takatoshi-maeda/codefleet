import { describe, expect, it } from "vitest";
import { formatAgentRuntimeEventDebugLine } from "../src/cli/commands/fleetctl.js";

describe("fleetctl runtime debug line formatting", () => {
  it("serializes full runtime event payload as json", () => {
    const line = formatAgentRuntimeEventDebugLine({
      agentId: "developer-1",
      provider: "codex-app-server",
      occurredAt: "2026-03-05T07:41:07.089Z",
      kind: "reasoning",
      nativeType: "codex/event/item_completed",
      message: "reasoning: thinking...",
      payload: {
        msg: {
          type: "item_completed",
          item: {
            type: "Reasoning",
            content: [{ type: "Text", text: "thinking..." }],
          },
        },
      },
    });

    expect(line.startsWith("[codefleet:fleetctl:runtime] ")).toBe(true);
    const payload = JSON.parse(line.slice("[codefleet:fleetctl:runtime] ".length)) as Record<string, unknown>;
    expect(payload).toEqual({
      ts: "2026-03-05T07:41:07.089Z",
      event: "fleet.agent.runtime.event",
      provider: "codex-app-server",
      agentId: "developer-1",
      kind: "reasoning",
      nativeType: "codex/event/item_completed",
      message: "reasoning: thinking...",
      payload: {
        msg: {
          type: "item_completed",
          item: {
            type: "Reasoning",
            content: [{ type: "Text", text: "thinking..." }],
          },
        },
      },
    });
  });
});
