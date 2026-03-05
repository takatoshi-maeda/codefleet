export interface FleetApiServerStatus {
  state: "running" | "stopped" | "error";
  host: string;
  port: number;
  startedAt: string | null;
  lastError?: string;
}

export interface FleetDiscoveredApiServer {
  instanceId: string;
  pid: number;
  projectId: string;
  host: string;
  port: number;
  startedAt: string;
  lastHeartbeat: string;
}

export interface FleetApiServerLifecycle {
  start(): Promise<FleetApiServerStatus>;
  stop(): Promise<void>;
  status(): FleetApiServerStatus;
  discover(): Promise<FleetDiscoveredApiServer[]>;
}
