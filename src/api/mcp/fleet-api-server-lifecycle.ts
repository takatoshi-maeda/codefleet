import { McpApiServer, type McpApiServerOptions } from "./server.js";
import type {
  FleetDiscoveredApiServer,
  FleetApiServerLifecycle,
  FleetApiServerStatus,
} from "../../domain/fleet/fleet-api-server-lifecycle-port.js";
import { LocalProcessRegistry } from "../../domain/fleet/local-process-registry.js";

export type { FleetApiServerLifecycle, FleetApiServerStatus };

export class McpApiServerLifecycle implements FleetApiServerLifecycle {
  private readonly server: McpApiServer;
  private readonly processRegistry: LocalProcessRegistry;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | undefined;

  constructor(options: McpApiServerOptions = {}) {
    this.server = new McpApiServer(options);
    this.processRegistry = new LocalProcessRegistry({ cwd: process.cwd() });
  }

  async start(): Promise<FleetApiServerStatus> {
    let serverStarted = false;
    try {
      const status = await this.server.start();
      serverStarted = true;
      await this.processRegistry.register({
        host: status.host,
        port: status.port,
        startedAt: status.startedAt ?? new Date().toISOString(),
      });
      this.startHeartbeat();
      this.lastError = undefined;
      return {
        state: status.state,
        host: status.host,
        port: status.port,
        startedAt: status.startedAt,
      };
    } catch (error) {
      this.stopHeartbeat();
      if (serverStarted) {
        await this.server.stop();
      }
      await this.processRegistry.unregister();
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    await this.server.stop();
    await this.processRegistry.unregister();
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

  async discover(): Promise<FleetDiscoveredApiServer[]> {
    return this.processRegistry.discover();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.processRegistry.heartbeat().catch(() => undefined);
    }, 2_000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
