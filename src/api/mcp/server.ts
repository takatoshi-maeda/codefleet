import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { mountMcpRoutes, type AgentMount } from "ai-kit/hono";
import { BacklogService } from "../../domain/backlog/backlog-service.js";
import { FleetObservabilityService } from "../../domain/fleet/fleet-observability-service.js";
import { FleetService } from "../../domain/fleet/fleet-service.js";
import { AgentEventQueueService } from "../../domain/events/agent-event-queue-service.js";
import { createCodefleetFrontDeskAgent, type CodefleetFrontDeskRuntimeConfig } from "../../agents/front-desk.js";
import type { FeedbackNoteEventPublisher } from "../../agents/tools/feedback-note-agent-tools.js";
import { LocalProcessRegistry, resolveProjectIdFromGitRemote } from "../../domain/fleet/local-process-registry.js";
import { registerBacklogMcpTools } from "./tools/backlog-tools.js";
import { registerFleetObservabilityTools } from "./tools/fleet-observability-tools.js";
import { JsonlMcpToolAuditLogger } from "./tools/mcp-tool-audit-log.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3290;
const DEFAULT_DATA_DIR = ".codefleet/runtime/mcp";
const DEFAULT_TOOL_AUDIT_LOG_PATH = ".codefleet/runtime/mcp/tool-executions.jsonl";
const FRONT_DESK_AGENT_NAME = "codefleet.front-desk";
const MCP_ALLOWED_ORIGINS = new Set(["http://localhost:8081"]);
const SERVER_STOP_TIMEOUT_MS = 5_000;

export interface McpServerBuildResult {
  app: Hono;
  mounts: Map<string, AgentMount>;
}

export interface McpApiServerStatus {
  state: "stopped" | "running";
  host: string;
  port: number;
  startedAt: string | null;
}

export interface McpApiServerOptions {
  host?: string;
  port?: number;
  autoSelectPortOnConflict?: boolean;
  dataDir?: string;
  toolAuditLogPath?: string;
  registryDir?: string;
  backlogService?: BacklogService;
  observabilityService?: FleetObservabilityService;
  frontDesk?: CodefleetFrontDeskRuntimeConfig;
}

export async function buildMcpServer(options: McpApiServerOptions = {}): Promise<McpServerBuildResult> {
  const app = new Hono();
  // Keep browser-access rules consistent across MCP and fleet introspection
  // endpoints so local dashboards can call both APIs from the same origin.
  app.use("/api/mcp", cors({ origin: resolveMcpCorsOrigin }));
  app.use("/api/mcp/*", cors({ origin: resolveMcpCorsOrigin }));
  app.use("/api/codefleet", cors({ origin: resolveMcpCorsOrigin }));
  app.use("/api/codefleet/*", cors({ origin: resolveMcpCorsOrigin }));
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const processRegistry = new LocalProcessRegistry({
    registryDir: options.registryDir,
    cwd: process.cwd(),
  });
  const fleetService = new FleetService();
  const projectIdPromise = resolveProjectIdFromGitRemote(process.cwd());

  app.get("/api/codefleet/endpoints", async (c) => {
    const requestUrl = new URL(c.req.url);
    const resolvedHost = requestUrl.hostname || host;
    const requestPort = Number(requestUrl.port);
    const resolvedPort = Number.isInteger(requestPort) && requestPort > 0 ? requestPort : port;
    const [projectId, peers] = await Promise.all([projectIdPromise, processRegistry.discover()]);
    const payload = {
      self: {
        projectId,
        pid: process.pid,
        host: resolvedHost,
        port: resolvedPort,
        endpoint: `http://${resolvedHost}:${resolvedPort}`,
      },
      peers: peers.map((peer) => ({
        projectId: peer.projectId,
        instanceId: peer.instanceId,
        pid: peer.pid,
        host: peer.host,
        port: peer.port,
        endpoint: `http://${peer.host}:${peer.port}`,
        startedAt: peer.startedAt,
        lastHeartbeat: peer.lastHeartbeat,
      })),
      updatedAt: new Date().toISOString(),
    };
    c.header("Cache-Control", "no-store");
    return c.json(payload);
  });

  app.get("/api/codefleet/status", async (c) => {
    const requestUrl = new URL(c.req.url);
    const resolvedHost = requestUrl.hostname || host;
    const requestPort = Number(requestUrl.port);
    const resolvedPort = Number.isInteger(requestPort) && requestPort > 0 ? requestPort : port;
    const [payload, projectId, peers] = await Promise.all([fleetService.status(), projectIdPromise, processRegistry.discover()]);
    const response = {
      ...payload,
      // This endpoint is served by a live MCP API server process, so its API
      // state is always running from the caller's perspective.
      apiServer: {
        state: "running" as const,
        host: resolvedHost,
        port: resolvedPort,
        startedAt: payload.apiServer?.startedAt ?? null,
      },
      nodes: {
        self: {
          projectId,
          pid: process.pid,
          host: resolvedHost,
          port: resolvedPort,
          endpoint: `http://${resolvedHost}:${resolvedPort}`,
        },
        peers: peers.map((peer) => ({
          projectId: peer.projectId,
          instanceId: peer.instanceId,
          pid: peer.pid,
          host: peer.host,
          port: peer.port,
          endpoint: `http://${peer.host}:${peer.port}`,
          startedAt: peer.startedAt,
          lastHeartbeat: peer.lastHeartbeat,
        })),
        updatedAt: new Date().toISOString(),
      },
    };
    c.header("Cache-Control", "no-store");
    return c.json(response);
  });

  const backlogService = options.backlogService ?? new BacklogService();
  const observabilityService = options.observabilityService ?? new FleetObservabilityService();
  const eventQueueService = new AgentEventQueueService();
  const toolAuditLogger = new JsonlMcpToolAuditLogger(options.toolAuditLogPath ?? DEFAULT_TOOL_AUDIT_LOG_PATH);
  const feedbackNoteEventPublisher = createFeedbackNoteEventPublisher(eventQueueService);
  const frontDeskRuntimeConfig: CodefleetFrontDeskRuntimeConfig = {
    ...(options.frontDesk ?? {}),
    feedbackNoteEventPublisher,
  };
  const mounts = await mountMcpRoutes(app, {
    basePath: "/api/mcp",
    dataDir,
    agentDefinitions: [
      {
        name: FRONT_DESK_AGENT_NAME,
        description: "User-facing support desk for backlog visibility",
        create: createCodefleetFrontDeskAgent(backlogService, frontDeskRuntimeConfig),
      },
    ],
  });
  const frontDeskMount = mounts.get(FRONT_DESK_AGENT_NAME);
  if (frontDeskMount) {
    // Register custom domain tools on the mounted MCP server so they are available
    // through both JSON-RPC calls and /tools/call HTTP bridge routes.
    registerBacklogMcpTools(frontDeskMount, backlogService, {
      agentName: FRONT_DESK_AGENT_NAME,
      logger: toolAuditLogger,
    });
    registerFleetObservabilityTools(frontDeskMount, backlogService, observabilityService, {
      agentName: FRONT_DESK_AGENT_NAME,
    });
  }

  return { app, mounts };
}

function createFeedbackNoteEventPublisher(
  queueService: Pick<AgentEventQueueService, "enqueueToRunningAgents">,
): FeedbackNoteEventPublisher {
  return {
    async publishFeedbackNoteCreated(path) {
      const result = await queueService.enqueueToRunningAgents({ type: "feedback-note.create", path });
      return { enqueuedAgentIds: result.enqueuedAgentIds };
    },
  };
}

function resolveMcpCorsOrigin(origin: string): string | undefined {
  const normalized = origin.trim().replace(/\/+$/, "");
  if (normalized.length === 0) {
    return undefined;
  }
  return MCP_ALLOWED_ORIGINS.has(normalized) ? normalized : undefined;
}

export class McpApiServer {
  private server: ReturnType<typeof serve> | null = null;
  private startedAt: string | null = null;
  private readonly activeSockets = new Set<Socket>();
  private detachConnectionTracking: (() => void) | null = null;
  private readonly host: string;
  private readonly preferredPort: number;
  private boundPort: number | null = null;
  private readonly autoSelectPortOnConflict: boolean;
  private readonly dataDir: string;
  private readonly toolAuditLogPath: string;
  private readonly registryDir?: string;
  private readonly backlogService?: BacklogService;
  private readonly observabilityService?: FleetObservabilityService;
  private readonly frontDesk?: CodefleetFrontDeskRuntimeConfig;

  constructor(options: McpApiServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.preferredPort = options.port ?? DEFAULT_PORT;
    this.autoSelectPortOnConflict = options.autoSelectPortOnConflict ?? true;
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this.toolAuditLogPath = options.toolAuditLogPath ?? DEFAULT_TOOL_AUDIT_LOG_PATH;
    this.registryDir = options.registryDir;
    this.backlogService = options.backlogService;
    this.observabilityService = options.observabilityService;
    this.frontDesk = options.frontDesk;
  }

  async start(): Promise<McpApiServerStatus> {
    if (this.server) {
      return this.status();
    }

    const { app } = await buildMcpServer({
      dataDir: this.dataDir,
      toolAuditLogPath: this.toolAuditLogPath,
      host: this.host,
      port: this.preferredPort,
      registryDir: this.registryDir,
      backlogService: this.backlogService,
      observabilityService: this.observabilityService,
      frontDesk: this.frontDesk,
    });
    try {
      const started = await this.startListening(app, this.preferredPort);
      this.server = started.server;
      this.boundPort = started.port;
      this.detachConnectionTracking = trackServerConnections(started.server, this.activeSockets);
    } catch (error) {
      const shouldRetryWithEphemeralPort =
        this.autoSelectPortOnConflict && this.preferredPort !== 0 && isAddressInUseError(error);
      if (!shouldRetryWithEphemeralPort) {
        this.server = null;
        this.boundPort = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to start MCP API server on ${this.host}:${this.preferredPort}: ${message}`);
      }
      try {
        const started = await this.startListening(app, 0);
        this.server = started.server;
        this.boundPort = started.port;
        this.detachConnectionTracking = trackServerConnections(started.server, this.activeSockets);
      } catch (fallbackError) {
        this.server = null;
        this.boundPort = null;
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`failed to start MCP API server on ${this.host}:${this.preferredPort}: ${message}`);
      }
    }
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  async stop(): Promise<void> {
    const target = this.server;
    if (!target) {
      return;
    }

    await closeServerWithActiveConnectionTermination(target, this.activeSockets);
    this.detachConnectionTracking?.();
    this.detachConnectionTracking = null;
    this.activeSockets.clear();
    this.server = null;
    this.boundPort = null;
    this.startedAt = null;
  }

  status(): McpApiServerStatus {
    return {
      state: this.server ? "running" : "stopped",
      host: this.host,
      port: this.boundPort ?? this.preferredPort,
      startedAt: this.startedAt,
    };
  }

  private async startListening(app: Hono, port: number): Promise<{ server: ReturnType<typeof serve>; port: number }> {
    return await new Promise<{ server: ReturnType<typeof serve>; port: number }>((resolve, reject) => {
      const created = serve(
        {
          fetch: app.fetch,
          hostname: this.host,
          port,
        },
        () => {
          const boundPort = resolveServerBoundPort(created, port);
          resolve({ server: created, port: boundPort });
        },
      );
      created.once("error", reject);
    });
  }
}

type CloseConnectionsCapableServer = ReturnType<typeof serve> & {
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

function trackServerConnections(server: ReturnType<typeof serve>, sockets: Set<Socket>): () => void {
  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  };

  server.on("connection", onConnection);
  return () => {
    server.off("connection", onConnection);
  };
}

function resolveServerBoundPort(server: ReturnType<typeof serve>, fallbackPort: number): number {
  const address = server.address();
  if (address && typeof address !== "string") {
    return (address as AddressInfo).port;
  }
  return fallbackPort;
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "EADDRINUSE") {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("EADDRINUSE");
}

async function closeServerWithActiveConnectionTermination(
  server: ReturnType<typeof serve>,
  sockets: Set<Socket>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for MCP API server shutdown after ${SERVER_STOP_TIMEOUT_MS}ms`));
    }, SERVER_STOP_TIMEOUT_MS);

    // Force-close active sockets (including SSE) so server.close can complete promptly.
    const forceCloseConnections = (): void => {
      const closeCapable = server as CloseConnectionsCapableServer;
      closeCapable.closeIdleConnections?.();
      closeCapable.closeAllConnections?.();
      for (const socket of sockets) {
        socket.destroy();
      }
    };

    server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    forceCloseConnections();
  });
}
