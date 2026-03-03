import { McpApiServer, type McpApiServerOptions } from "./server.js";
import type {
  FleetApiServerLifecycle,
  FleetApiServerStatus,
} from "../../domain/fleet/fleet-api-server-lifecycle-port.js";

export type { FleetApiServerLifecycle, FleetApiServerStatus };

export class McpApiServerLifecycle implements FleetApiServerLifecycle {
  private readonly server: McpApiServer;
  private lastError: string | undefined;

  constructor(options: McpApiServerOptions = {}) {
    this.server = new McpApiServer(options);
  }

  async start(): Promise<FleetApiServerStatus> {
    try {
      const status = await this.server.start();
      this.lastError = undefined;
      return {
        state: status.state,
        host: status.host,
        port: status.port,
        startedAt: status.startedAt,
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.server.stop();
    this.lastError = undefined;
  }

  status(): FleetApiServerStatus {
    const status = this.server.status();
    return {
      state: this.lastError ? "error" : status.state,
      host: status.host,
      port: status.port,
      startedAt: status.startedAt,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}
