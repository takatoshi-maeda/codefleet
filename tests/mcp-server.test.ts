import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LLMClient, LLMChatInput, LLMMessage } from "ai-kit";
import { BacklogService } from "../src/domain/backlog/backlog-service.js";
import type { CodefleetFrontDeskRuntimeConfig } from "../src/agents/front-desk.js";
import { McpApiServer } from "../src/api/mcp/server.js";
import { resolveProjectIdFromGitRemote } from "../src/domain/fleet/local-process-registry.js";

describe("McpApiServer", () => {
  it("exposes codefleet.front-desk in /api/mcp and reports ready status", async () => {
    const port = 39000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: `.codefleet/runtime/mcp-test-${Date.now().toString(16)}`,
      frontDesk: createFrontDeskMockConfig(),
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

      const fleetStatusResponse = await fetch(`http://127.0.0.1:${port}/api/codefleet/status`);
      const fleetStatusJson = (await fleetStatusResponse.json()) as {
        summary?: string;
        agents?: unknown[];
        sessions?: unknown[];
        nodes?: { self?: { port?: number; projectId?: string } };
        apiServer?: { state?: string; host?: string; port?: number };
      };
      expect(fleetStatusResponse.status).toBe(200);
      expect(typeof fleetStatusJson.summary).toBe("string");
      expect(Array.isArray(fleetStatusJson.agents)).toBe(true);
      expect(Array.isArray(fleetStatusJson.sessions)).toBe(true);
      expect(fleetStatusJson.apiServer).toMatchObject({
        state: "running",
        host: "127.0.0.1",
        port,
      });
      expect(fleetStatusJson.nodes?.self?.port).toBe(port);
      expect(typeof fleetStatusJson.nodes?.self?.projectId).toBe("string");

      const corsResponse = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
        headers: { origin: "http://localhost:8081" },
      });
      expect(corsResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");

      const fleetStatusCorsResponse = await fetch(`http://127.0.0.1:${port}/api/codefleet/status`, {
        headers: { origin: "http://localhost:8081" },
      });
      expect(fleetStatusCorsResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");

      const fleetStatusPreflightResponse = await fetch(`http://127.0.0.1:${port}/api/codefleet/status`, {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:8081",
          "access-control-request-method": "GET",
        },
      });
      expect(fleetStatusPreflightResponse.status).toBe(204);
      expect(fleetStatusPreflightResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    } finally {
      await server.stop();
    }
  });

  it("falls back to an available port when the requested port is already in use", async () => {
    const occupiedPort = 43500 + Math.floor(Math.random() * 200);
    const primary = new McpApiServer({
      host: "127.0.0.1",
      port: occupiedPort,
      dataDir: `.codefleet/runtime/mcp-test-primary-${Date.now().toString(16)}`,
      frontDesk: createFrontDeskMockConfig(),
    });
    const secondary = new McpApiServer({
      host: "127.0.0.1",
      port: occupiedPort,
      dataDir: `.codefleet/runtime/mcp-test-secondary-${Date.now().toString(16)}`,
      frontDesk: createFrontDeskMockConfig(),
    });

    try {
      const primaryStatus = await primary.start();
      expect(primaryStatus.port).toBe(occupiedPort);

      const secondaryStatus = await secondary.start();
      expect(secondaryStatus.state).toBe("running");
      expect(secondaryStatus.port).not.toBe(occupiedPort);

      const endpointsResponse = await fetch(`http://127.0.0.1:${secondaryStatus.port}/api/codefleet/endpoints`);
      expect(endpointsResponse.status).toBe(200);
      const endpointsJson = (await endpointsResponse.json()) as {
        self?: { port?: number; projectId?: string };
      };
      expect(endpointsJson.self?.port).toBe(secondaryStatus.port);
      expect(typeof endpointsJson.self?.projectId).toBe("string");
    } finally {
      await secondary.stop();
      await primary.stop();
    }
  });

  it("serves document tree/file APIs and emits document watch updates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-docs-"));
    const docsRoot = path.join(tempDir, "docs/spec");
    const firstDocPath = path.join(docsRoot, "requirements.md");
    await fs.mkdir(docsRoot, { recursive: true });
    await fs.writeFile(firstDocPath, "# Requirements\n", "utf8");

    const port = 40100 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      documentsWorkspaceRootDir: tempDir,
      frontDesk: {
        ...createFrontDeskMockConfig(),
        fileToolWorkingDir: tempDir,
      },
    });

    try {
      await server.start();

      const treeResponse = await fetch(`http://127.0.0.1:${port}/api/codefleet/documents/tree`);
      expect(treeResponse.status).toBe(200);
      const treeJson = (await treeResponse.json()) as {
        root?: Array<{ path?: string; children?: Array<{ path?: string }> }>;
      };
      expect(treeJson.root?.[0]?.path).toBe("docs/spec");
      expect(treeJson.root?.[0]?.children?.some((child) => child.path === "docs/spec/requirements.md")).toBe(true);

      const fileResponse = await fetch(
        `http://127.0.0.1:${port}/api/codefleet/documents/file?path=${encodeURIComponent("docs/spec/requirements.md")}`,
      );
      expect(fileResponse.status).toBe(200);
      const fileJson = (await fileResponse.json()) as { content?: string; version?: string };
      expect(fileJson.content).toContain("# Requirements");
      expect(String(fileJson.version ?? "")).toContain("sha256:");

      const watchResponse = await fetch(`http://127.0.0.1:${port}/api/codefleet/documents/watch`, {
        headers: { accept: "text/event-stream" },
      });
      expect(watchResponse.status).toBe(200);
      expect(watchResponse.headers.get("content-type")).toContain("text/event-stream");
      const watchReader = createSseReader(watchResponse);
      const snapshotBody = await readSseReaderChunks(watchReader, 1);
      expect(snapshotBody).toContain("event: document.snapshot");
      expect(snapshotBody).toContain("\"rootDir\":\"docs/spec\"");

      const updateResponse = await fetch(`http://127.0.0.1:${port}/api/codefleet/documents/file`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "docs/spec/requirements.md",
          content: "# Requirements\nupdated\n",
          baseVersion: fileJson.version,
          actor: { type: "user", id: "browser-test" },
        }),
      });
      expect(updateResponse.status).toBe(200);
      const updatedJson = (await updateResponse.json()) as { content?: string; version?: string };
      expect(updatedJson.content).toContain("updated");
      expect(updatedJson.version).not.toBe(fileJson.version);

      const changedBody = await readSseReaderUntil(watchReader, "\"path\":\"docs/spec/requirements.md\"");
      expect(changedBody).toContain("event: document.changed");
      expect(changedBody).toContain("\"path\":\"docs/spec/requirements.md\"");

      await fs.writeFile(path.join(docsRoot, "external.md"), "# External\n", "utf8");
      const externalBody = await readSseReaderUntil(watchReader, "\"path\":\"docs/spec/external.md\"");
      expect(externalBody).toContain("\"path\":\"docs/spec/external.md\"");
      await watchReader.cancel();
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
      frontDesk: createFrontDeskMockConfig(),
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

      const fleetWatchStreamResponse = await fetch(
        `http://127.0.0.1:${port}/api/mcp/codefleet.front-desk/tools/call/fleet.watch`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({ arguments: { heartbeatSec: 5 } }),
        },
      );
      expect(fleetWatchStreamResponse.status).toBe(200);
      expect(fleetWatchStreamResponse.headers.get("content-type")).toContain("text/event-stream");
      const fleetWatchStreamBody = await readSseChunks(fleetWatchStreamResponse, 2);
      expect(fleetWatchStreamBody).toContain("\"method\":\"backlog.snapshot\"");
      expect(fleetWatchStreamBody).toContain("\"method\":\"fleet.activity.snapshot\"");

      const notFound = await callTool(port, "backlog.item.get", { id: "I-404" });
      expect(notFound.result?.isError).toBe(true);
      expect(notFound.result?.structuredContent?.error?.code).toBe("ERR_NOT_FOUND");

      const validation = await callTool(port, "backlog.item.get", {});
      expect(validation.result?.isError).toBe(true);
      expect(validation.result?.structuredContent?.error?.code).toBe("ERR_VALIDATION");

      const agentGet = await callTool(port, "agent.run", { message: `${epic.id} の状況を教えて` });
      expect(agentGet.result?.isError).toBe(false);
      expect(String(agentGet.result?.structuredContent?.message ?? "")).toContain("tool: backlog_epic_get");

      const agentList = await callTool(port, "agent.run", { message: "item一覧を見せて" });
      expect(agentList.result?.isError).toBe(false);
      expect(String(agentList.result?.structuredContent?.message ?? "")).toContain("tool: backlog_item_list");

      const imageSessionId = `sess-image-${Date.now().toString(16)}`;
      const imageInput = [
        {
          type: "image",
          source: { type: "url", url: "https://example.com/mock-image.png" },
        },
        { type: "text", text: "この画像の要点を教えて" },
      ];
      const multimodalRun = await callTool(port, "agent.run", {
        sessionId: imageSessionId,
        input: imageInput,
      });
      expect(multimodalRun.result?.isError).toBe(false);

      const conversation = await callTool(port, "conversations.get", { sessionId: imageSessionId });
      expect(conversation.result?.isError).toBe(false);
      const firstTurn = conversation.result?.structuredContent?.turns?.[0] as { userContent?: unknown } | undefined;
      expect(firstTurn?.userContent).toEqual(imageInput);

      const base64SessionId = `sess-base64-${Date.now().toString(16)}`;
      const base64Run = await callTool(port, "agent.run", {
        sessionId: base64SessionId,
        input: [
          {
            type: "image",
            source: {
              type: "base64",
              mediaType: "image/png",
              data:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Nm7cAAAAASUVORK5CYII=",
            },
          },
          { type: "text", text: "保存して" },
        ],
      });
      expect(base64Run.result?.isError).toBe(false);

      const base64Conversation = await callTool(port, "conversations.get", { sessionId: base64SessionId });
      expect(base64Conversation.result?.isError).toBe(false);
      const base64Turn = base64Conversation.result?.structuredContent?.turns?.[0] as {
        userContent?: Array<{ type?: string; source?: { type?: string; url?: string } }>;
      } | undefined;
      const base64ImageUrl = base64Turn?.userContent?.[0]?.source?.url;
      expect(base64ImageUrl).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/mcp/codefleet\\.front-desk/public/uploads/\\d{4}/\\d{2}/\\d{2}/sess-base64-[^/]+/[0-9a-f-]+\\.png$`),
      );
      const servedImage = await fetch(String(base64ImageUrl));
      expect(servedImage.status).toBe(200);
      expect(servedImage.headers.get("content-type")).toContain("image/png");
      expect(servedImage.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const dataUrlSessionId = `sess-dataurl-${Date.now().toString(16)}`;
      const dataUrlRun = await callTool(port, "agent.run", {
        sessionId: dataUrlSessionId,
        input: [
          {
            type: "image",
            source: {
              type: "url",
              url:
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Nm7cAAAAASUVORK5CYII=",
            },
          },
          { type: "text", text: "data url 正規化" },
        ],
      });
      expect(dataUrlRun.result?.isError).toBe(false);
      const dataUrlConversation = await callTool(port, "conversations.get", { sessionId: dataUrlSessionId });
      const dataUrlTurn = dataUrlConversation.result?.structuredContent?.turns?.[0] as {
        userContent?: Array<{ source?: { type?: string; url?: string } }>;
      } | undefined;
      const normalizedDataUrl = dataUrlTurn?.userContent?.[0]?.source?.url;
      expect(normalizedDataUrl).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/mcp/codefleet\\.front-desk/public/uploads/\\d{4}/\\d{2}/\\d{2}/sess-dataurl-[^/]+/[0-9a-f-]+\\.png$`),
      );
    } finally {
      await server.stop();
    }
  });

  it("closes active SSE streams during stop so shutdown does not hang", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-stop-sse-"));
    const port = 40500 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      frontDesk: createFrontDeskMockConfig(),
    });

    await server.start();
    const streamResponse = await fetch(
      `http://127.0.0.1:${port}/api/mcp/codefleet.front-desk/tools/call/fleet.watch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ arguments: { heartbeatSec: 30 } }),
      },
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

    try {
      await expect(
        Promise.race([
          server.stop(),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error("server.stop() timed out while SSE stream remained open"));
            }, 2_000);
          }),
        ]),
      ).resolves.toBeUndefined();
    } finally {
      await streamResponse.body?.cancel();
    }
  });

  it("returns same-machine peer endpoints from local registry API", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-endpoints-"));
    const registryDir = path.join(tempDir, "registry");
    await fs.mkdir(registryDir, { recursive: true });
    const projectId = await resolveProjectIdFromGitRemote(process.cwd());
    const now = new Date().toISOString();
    const staleHeartbeat = new Date(Date.now() - 120_000).toISOString();
    const livePeerProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], {
      stdio: "ignore",
      detached: true,
    });
    const livePeerPid = livePeerProcess.pid;
    if (!livePeerPid) {
      throw new Error("failed to spawn live peer process for endpoint discovery test");
    }
    livePeerProcess.unref();
    await fs.writeFile(
      path.join(registryDir, "1.json"),
      JSON.stringify({
        instanceId: "cf-peer-live",
        pid: 1,
        projectId,
        host: "127.0.0.1",
        port: 3391,
        startedAt: now,
        lastHeartbeat: now,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(registryDir, "99999.json"),
      JSON.stringify({
        instanceId: "cf-peer-stale",
        pid: 99999,
        projectId,
        host: "127.0.0.1",
        port: 3392,
        startedAt: now,
        lastHeartbeat: staleHeartbeat,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(registryDir, "2.json"),
      JSON.stringify({
        instanceId: "cf-peer-other-project",
        pid: livePeerPid,
        projectId: "other/repo",
        host: "127.0.0.1",
        port: 3393,
        startedAt: now,
        lastHeartbeat: now,
      }),
      "utf8",
    );

    const port = 40600 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      registryDir,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      frontDesk: createFrontDeskMockConfig(),
    });

    try {
      await server.start();
      const response = await fetch(`http://127.0.0.1:${port}/api/codefleet/endpoints`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const json = (await response.json()) as {
        self?: { projectId?: string; host?: string; port?: number; endpoint?: string };
        peers?: Array<{ projectId?: string; instanceId?: string; host?: string; port?: number; endpoint?: string }>;
      };
      expect(json.self).toEqual({
        projectId,
        pid: process.pid,
        host: "127.0.0.1",
        port,
        endpoint: `http://127.0.0.1:${port}`,
      });
      expect(json.peers).toEqual([
        {
          projectId,
          instanceId: "cf-peer-live",
          pid: 1,
          host: "127.0.0.1",
          port: 3391,
          endpoint: "http://127.0.0.1:3391",
          startedAt: now,
          lastHeartbeat: now,
        },
        {
          projectId: "other/repo",
          instanceId: "cf-peer-other-project",
          pid: livePeerPid,
          host: "127.0.0.1",
          port: 3393,
          endpoint: "http://127.0.0.1:3393",
          startedAt: now,
          lastHeartbeat: now,
        },
      ]);
    } finally {
      await server.stop();
      try {
        process.kill(livePeerPid, "SIGTERM");
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ESRCH") {
          throw error;
        }
      }
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
      frontDesk: createFrontDeskMockConfig(),
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

  it("fails fast when llm mode is configured without api key", async () => {
    const port = 42000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: `.codefleet/runtime/mcp-test-${Date.now().toString(16)}`,
      frontDesk: {
        llm: {
          provider: "openai",
          model: "gpt-5.3-codex",
          apiKeyEnv: "CODEFLEET_TEST_MISSING_KEY",
        },
      },
    });
    await expect(server.start()).rejects.toThrow(/CODEFLEET_TEST_MISSING_KEY/);
  });

  it("serves agent.run in llm mode using backlog tools", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codefleet-mcp-llm-agent-"));
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
    const epic = await backlogService.addEpic({ title: "llm-epic", acceptanceTestIds: [] });

    let streamCallCount = 0;
    const streamInputs: LLMChatInput[] = [];
    const mockClient: LLMClient = {
      provider: "openai",
      model: "mock-mcp-llm",
      capabilities: {
        supportsReasoning: true,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsImages: false,
        contextWindowSize: 8_000,
      },
      estimateTokens: () => 0,
      invoke: async () => {
        throw new Error("invoke should not be called");
      },
      stream: async function* (input: LLMChatInput) {
        streamCallCount += 1;
        streamInputs.push(input);
        if (streamCallCount === 1) {
          yield {
            type: "response.completed",
            result: {
              type: "tool_use",
              content: null,
              toolCalls: [
                {
                  id: "tc-epic-get",
                  name: "backlog_epic_get",
                  arguments: { id: epic.id },
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
            content: `Epic ${epic.id} を確認しました。`,
            toolCalls: [],
            usage: emptyUsage(),
            responseId: "resp-2",
            finishReason: "stop",
          },
        };
      },
    };

    const port = 43000 + Math.floor(Math.random() * 1000);
    const server = new McpApiServer({
      host: "127.0.0.1",
      port,
      dataDir: path.join(tempDir, ".codefleet/runtime/mcp"),
      backlogService,
      frontDesk: {
        llm: { provider: "openai", model: "gpt-5.3-codex", apiKey: "test-key" },
        clientFactory: () => mockClient,
        maxTurns: 4,
      },
    });

    try {
      await server.start();
      const agentRun = await callTool(port, "agent.run", { message: "epic detail please" });
      expect(agentRun.result?.isError).toBe(false);
      expect(String(agentRun.result?.structuredContent?.message ?? "")).toContain(epic.id);
      expect(streamCallCount).toBe(2);
      expect(streamInputs[0]?.tools?.map((tool) => tool.name)).toEqual([
        "backlog_epic_list",
        "backlog_epic_get",
        "backlog_item_list",
        "backlog_item_get",
        "feedback_note_create",
        "feedback_note_list",
        "ListDirectory",
        "ReadFile",
        "WriteFile",
        "MakeDirectory",
      ]);
    } finally {
      await server.stop();
    }
  });
});

async function readSseChunks(response: Response, chunkCount: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let chunks = "";
  let reads = 0;
  try {
    while (reads < chunkCount) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks += decoder.decode(value, { stream: true });
      reads += 1;
    }
  } finally {
    await reader.cancel();
  }
  return chunks;
}

function createSseReader(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("response.body reader unavailable");
  }
  return reader;
}

async function readSseReaderChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkCount: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let chunks = "";
  let reads = 0;
  while (reads < chunkCount) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks += decoder.decode(value, { stream: true });
    reads += 1;
  }
  return chunks;
}

async function readSseReaderUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string,
  maxReads: number = 20,
): Promise<string> {
  let collected = "";
  for (let index = 0; index < maxReads; index += 1) {
    collected += await readSseReaderChunks(reader, 1);
    if (collected.includes(pattern)) {
      return collected;
    }
  }
  throw new Error(`pattern not found in SSE stream: ${pattern}`);
}

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

function createFrontDeskMockConfig(): CodefleetFrontDeskRuntimeConfig {
  return {
    llm: { provider: "openai", model: "gpt-5.3-codex", apiKey: "test-key" },
    clientFactory: () => createDeterministicFrontDeskMockClient(),
    maxTurns: 4,
  };
}

function createDeterministicFrontDeskMockClient(): LLMClient {
  return {
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
      throw new Error("invoke should not be called");
    },
    stream: async function* (input: LLMChatInput) {
      const lastToolMessage = findLastToolMessage(input.messages);
      if (lastToolMessage) {
        const resolvedToolName = lastToolMessage.name ?? "unknown";
        yield {
          type: "response.completed",
          result: {
            type: "message",
            content: `tool: ${resolvedToolName}`,
            toolCalls: [],
            usage: emptyUsage(),
            responseId: "resp-finish",
            finishReason: "stop",
          },
        };
        return;
      }

      const userMessage = findLastUserMessage(input.messages).toLowerCase();
      const selectedToolName = userMessage.includes("item")
        ? "backlog_item_list"
        : /e-\d{3,}/i.test(userMessage)
          ? "backlog_epic_get"
          : "backlog_epic_list";
      const selectedArgs = selectedToolName === "backlog_epic_get" ? { id: findFirstEpicId(userMessage) } : {};

      yield {
        type: "response.completed",
        result: {
          type: "tool_use",
          content: null,
          toolCalls: [
            {
              id: "tc-deterministic",
              name: selectedToolName,
              arguments: selectedArgs,
            },
          ],
          usage: emptyUsage(),
          responseId: "resp-tool",
          finishReason: "tool_use",
        },
      };
    },
  };
}

function findLastToolMessage(messages: LLMMessage[]): LLMMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "tool") {
      return messages[index];
    }
  }
  return undefined;
}

function findLastUserMessage(messages: LLMMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && typeof messages[index].content === "string") {
      return messages[index].content;
    }
  }
  return "";
}

function findFirstEpicId(message: string): string {
  const matched = message.match(/\be-\d{3,}\b/i);
  return matched?.[0]?.toUpperCase() ?? "E-001";
}
