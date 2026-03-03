import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mountMcpRoutes, type AgentMount } from "ai-kit/hono";
import { BacklogService } from "../../domain/backlog/backlog-service.js";
import { FleetObservabilityService } from "../../domain/fleet/fleet-observability-service.js";
import { createCodefleetFrontDeskAgent, type CodefleetFrontDeskRuntimeConfig } from "../../agents/front-desk.js";
import { registerBacklogMcpTools } from "./tools/backlog-tools.js";
import { registerFleetObservabilityTools } from "./tools/fleet-observability-tools.js";
import { JsonlMcpToolAuditLogger } from "./tools/mcp-tool-audit-log.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3290;
const DEFAULT_DATA_DIR = ".codefleet/runtime/mcp";
const DEFAULT_TOOL_AUDIT_LOG_PATH = ".codefleet/runtime/mcp/tool-executions.jsonl";
const FRONT_DESK_AGENT_NAME = "codefleet.front-desk";
const MCP_ALLOWED_ORIGINS = new Set(["http://localhost:8081"]);

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
  dataDir?: string;
  toolAuditLogPath?: string;
  backlogService?: BacklogService;
  observabilityService?: FleetObservabilityService;
  frontDesk?: CodefleetFrontDeskRuntimeConfig;
}

export async function buildMcpServer(options: McpApiServerOptions = {}): Promise<McpServerBuildResult> {
  const app = new Hono();
  app.use("/api/mcp", cors({ origin: resolveMcpCorsOrigin }));
  app.use("/api/mcp/*", cors({ origin: resolveMcpCorsOrigin }));
  const backlogService = options.backlogService ?? new BacklogService();
  const observabilityService = options.observabilityService ?? new FleetObservabilityService();
  const toolAuditLogger = new JsonlMcpToolAuditLogger(options.toolAuditLogPath ?? DEFAULT_TOOL_AUDIT_LOG_PATH);
  const mounts = await mountMcpRoutes(app, {
    basePath: "/api/mcp",
    dataDir: options.dataDir ?? DEFAULT_DATA_DIR,
    agentDefinitions: [
      {
        name: FRONT_DESK_AGENT_NAME,
        description: "User-facing support desk for backlog visibility",
        create: createCodefleetFrontDeskAgent(backlogService, options.frontDesk),
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
    registerFleetObservabilityTools(frontDeskMount, observabilityService, {
      agentName: FRONT_DESK_AGENT_NAME,
    });
  }

  return { app, mounts };
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
  private readonly host: string;
  private readonly port: number;
  private readonly dataDir: string;
  private readonly toolAuditLogPath: string;
  private readonly backlogService?: BacklogService;
  private readonly observabilityService?: FleetObservabilityService;
  private readonly frontDesk?: CodefleetFrontDeskRuntimeConfig;

  constructor(options: McpApiServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this.toolAuditLogPath = options.toolAuditLogPath ?? DEFAULT_TOOL_AUDIT_LOG_PATH;
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
      backlogService: this.backlogService,
      observabilityService: this.observabilityService,
      frontDesk: this.frontDesk,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const created = serve(
          {
            fetch: app.fetch,
            hostname: this.host,
            port: this.port,
          },
          () => resolve(),
        );
        created.once("error", reject);
        this.server = created;
      });
    } catch (error) {
      this.server = null;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to start MCP API server on ${this.host}:${this.port}: ${message}`);
    }
    this.startedAt = new Date().toISOString();
    return this.status();
  }

  async stop(): Promise<void> {
    const target = this.server;
    if (!target) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      target.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.server = null;
    this.startedAt = null;
  }

  status(): McpApiServerStatus {
    return {
      state: this.server ? "running" : "stopped",
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
    };
  }
}
