import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mountMcpRoutes, type AgentMount } from "../../../vendor/ai-kit/src/hono/index.js";
import { BacklogService } from "../../domain/backlog/backlog-service.js";
import { NoopFrontDeskAgent } from "./agents/noop-agent.js";
import { registerBacklogMcpTools } from "./tools/backlog-tools.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3290;
const DEFAULT_DATA_DIR = ".codefleet/runtime/mcp";
const FRONT_DESK_AGENT_NAME = "codefleet.front-desk";

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
  backlogService?: BacklogService;
}

export async function buildMcpServer(options: McpApiServerOptions = {}): Promise<McpServerBuildResult> {
  const app = new Hono();
  const backlogService = options.backlogService ?? new BacklogService();
  const mounts = await mountMcpRoutes(app, {
    basePath: "/api/mcp",
    dataDir: options.dataDir ?? DEFAULT_DATA_DIR,
    agentDefinitions: [
      {
        name: FRONT_DESK_AGENT_NAME,
        description: "User-facing support desk for backlog visibility",
        create: (context) => new NoopFrontDeskAgent(context) as never,
      },
    ],
  });
  const frontDeskMount = mounts.get(FRONT_DESK_AGENT_NAME);
  if (frontDeskMount) {
    // Register custom domain tools on the mounted MCP server so they are available
    // through both JSON-RPC calls and /tools/call HTTP bridge routes.
    registerBacklogMcpTools(frontDeskMount, backlogService);
  }

  return { app, mounts };
}

export class McpApiServer {
  private server: ReturnType<typeof serve> | null = null;
  private startedAt: string | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly dataDir: string;
  private readonly backlogService?: BacklogService;

  constructor(options: McpApiServerOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this.backlogService = options.backlogService;
  }

  async start(): Promise<McpApiServerStatus> {
    if (this.server) {
      return this.status();
    }

    const { app } = await buildMcpServer({
      dataDir: this.dataDir,
      backlogService: this.backlogService,
    });
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
