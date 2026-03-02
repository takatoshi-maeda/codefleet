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

      const corsResponse = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
        headers: { origin: "http://localhost:8081" },
      });
      expect(corsResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
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

      const activityList = await callTool(port, "fleet.activity.list", {});
      expect(activityList.result?.isError).toBe(false);
      expect(Array.isArray(activityList.result?.structuredContent?.roles)).toBe(true);

      const notFound = await callTool(port, "backlog.item.get", { id: "I-404" });
      expect(notFound.result?.isError).toBe(true);
      expect(notFound.result?.structuredContent?.error?.code).toBe("ERR_NOT_FOUND");

      const validation = await callTool(port, "backlog.item.get", {});
      expect(validation.result?.isError).toBe(true);
      expect(validation.result?.structuredContent?.error?.code).toBe("ERR_VALIDATION");

      const agentGet = await callTool(port, "agent.run", { message: `${epic.id} の状況を教えて` });
      expect(agentGet.result?.isError).toBe(false);
      expect(String(agentGet.result?.structuredContent?.message ?? "")).toContain("tool: backlog.epic.get");

      const agentList = await callTool(port, "agent.run", { message: "item一覧を見せて" });
      expect(agentList.result?.isError).toBe(false);
      expect(String(agentList.result?.structuredContent?.message ?? "")).toContain("tool: backlog.item.list");
    } finally {
      await server.stop();
    }
  });

  it("writes backlog tool audit logs as JSONL", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-audit-"));
    const backlogDir = path.join(tempDir, ".codefleet/data/backlog");
    const acceptanceSpecPath = path.join(tempDir, ".codefleet/data/acceptance-testing/spec.json");
    const rolesPath = path.join(tempDir, ".codefleet/roles.json");
    const auditLogPath = path.join(tempDir, ".codefleet/runtime/mcp/tool-executions.jsonl");

    await fs.mkdir(path.dirname(acceptanceSpecPath), { recursive: true });
    await fs.writeFile(
      acceptanceSpecPath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", tests: [] }, null, 2),
      "utf8",
    );
    await fs.mkdir(path.dirname(rolesPath), { recursive: true });
    await fs.writeFile(rolesPath, JSON.stringify({ agents: [] }, null, 2), "utf8");

    const backlogService = new BacklogService(backlogDir, acceptanceSpecPath, rolesPath);
    await backlogService.addEpic({ title: "audit target", acceptanceTestIds: [] });

    const port = 41000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      toolAuditLogPath: auditLogPath,
      backlogService,
    });

    try {
      await server.start();
      const listResult = await callTool(port, "backlog.epic.list", {});
      expect(listResult.result?.isError).toBe(false);
    } finally {
      await server.stop();
    }

    const raw = await fs.readFile(auditLogPath, "utf8");
    const lines = raw.trim().split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      agent?: string;
      tool?: string;
      durationMs?: number;
      isError?: boolean;
      resultCount?: number;
    };
    expect(parsed.agent).toBe("codefleet.front-desk");
    expect(parsed.tool).toBe("backlog.epic.list");
    expect(parsed.isError).toBe(false);
    expect(typeof parsed.durationMs).toBe("number");
    expect(parsed.resultCount).toBe(1);
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
  const bodyText = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLines = bodyText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .filter((line) => line.length > 0);
    const lastData = dataLines[dataLines.length - 1] ?? "{}";
    return JSON.parse(lastData) as {
      result?: {
        isError?: boolean;
        structuredContent?: Record<string, any>;
      };
    };
  }
  return JSON.parse(bodyText) as {
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, any>;
    };
  };
}
