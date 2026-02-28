import { describe, expect, it } from "vitest";
import { McpApiServer } from "../src/api/mcp/server.js";

describe("McpApiServer", () => {
  it("exposes codefleet.front-desk in /api/mcp and reports ready status", async () => {
    const port = 39000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: `.codefleet/runtime/mcp-test-${Date.now().toString(16)}`,
    });

    try {
      await server.start();
      const listResponse = await fetch(`http://127.0.0.1:${port}/api/mcp`);
      const listJson = (await listResponse.json()) as { agents?: Array<{ name: string }> };
      expect(listResponse.status).toBe(200);
      expect(listJson.agents?.some((agent) => agent.name === "codefleet.front-desk")).toBe(true);

      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/codefleet.front-desk/status`);
      const statusJson = (await statusResponse.json()) as { state?: string };
      expect(statusResponse.status).toBe(200);
      expect(statusJson.state).toBe("ready");
    } finally {
      await server.stop();
    }
  });
});
