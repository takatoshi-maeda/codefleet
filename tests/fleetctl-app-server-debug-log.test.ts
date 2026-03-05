import { describe, expect, it } from "vitest";
import { formatAppServerNotificationDebugLine } from "../src/cli/commands/fleetctl.js";

describe("fleetctl app-server debug line formatting", () => {
  it("serializes full AppServer notification payload as json", () => {
    const line = formatAppServerNotificationDebugLine({
      agentId: "developer-1",
      method: "codex/event/item_completed",
      receivedAt: "2026-03-05T07:41:07.089Z",
      params: {
        msg: {
          type: "item_completed",
          item: {
            type: "Reasoning",
            content: [{ type: "Text", text: "thinking..." }],
          },
        },
      },
    });

    expect(line.startsWith("[codefleet:fleetctl:app-server] ")).toBe(true);
    const payload = JSON.parse(line.slice("[codefleet:fleetctl:app-server] ".length)) as Record<string, unknown>;
    expect(payload).toEqual({
      ts: "2026-03-05T07:41:07.089Z",
      event: "fleet.app-server.notification",
      agentId: "developer-1",
      method: "codex/event/item_completed",
      params: {
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

