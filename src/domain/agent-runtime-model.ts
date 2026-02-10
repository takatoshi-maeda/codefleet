import type { AgentRole } from "./roles-model.js";

export type AgentRuntimeStatus = "starting" | "running" | "stopped" | "failed";

export interface AgentRuntime {
  id: string;
  role: AgentRole;
  status: AgentRuntimeStatus;
  pid: number | null;
  cwd: string;
  startedAt: string;
  lastHeartbeatAt: string;
  lastError?: string;
}

export interface AgentRuntimeCollection {
  version: number;
  updatedAt: string;
  agents: AgentRuntime[];
}
