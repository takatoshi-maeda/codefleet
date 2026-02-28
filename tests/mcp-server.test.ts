import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";
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

  it("serves backlog tools via tools/call bridge with success and domain errors", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-backlog-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const backlogService = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    const epic = await backlogService.addEpic({ title: "e1", acceptanceTestIds: [] });
    const item = await backlogService.addItem({ epicId: epic.id, title: "i1", acceptanceTestIds: [] });

    const port = 40000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      backlogService,
    });
    try {
      await server.start();

      const epicList = await callTool(port, "backlog.epic.list", {});
      expect(epicList.result?.isError).toBe(false);
      expect(epicList.result?.structuredContent?.count).toBe(1);

      const epicGet = await callTool(port, "backlog.epic.get", { id: epic.id });
      expect(epicGet.result?.isError).toBe(false);
      expect(epicGet.result?.structuredContent?.epic?.id).toBe(epic.id);

      const itemList = await callTool(port, "backlog.item.list", { epicId: epic.id });
      expect(itemList.result?.isError).toBe(false);
      expect(itemList.result?.structuredContent?.count).toBe(1);

      const itemGet = await callTool(port, "backlog.item.get", { id: item.id });
      expect(itemGet.result?.isError).toBe(false);
      expect(itemGet.result?.structuredContent?.item?.id).toBe(item.id);

      const notFound = await callTool(port, "backlog.item.get", { id: "I-404" });
      expect(notFound.result?.isError).toBe(true);
      expect(notFound.result?.structuredContent?.error?.code).toBe("ERR_NOT_FOUND");

      const validation = await callTool(port, "backlog.item.get", {});
      expect(validation.result?.isError).toBe(true);
      expect(validation.result?.structuredContent?.error?.code).toBe("ERR_VALIDATION");
    } finally {
      await server.stop();
    }
  });
});

async function callTool(port: number, tool: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp/codefleet.front-desk/tools/call/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ arguments: args }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, any>;
    };
  };
}
