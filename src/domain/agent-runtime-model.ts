import type { AgentProviderId } from "./fleet/role-agent-runtime.js";
import type { AgentRole } from "./roles-model.js";

export type AgentRuntimeStatus = "starting" | "running" | "stopped" | "failed";

export interface AgentRuntime {
  id: string;
  role: AgentRole;
  provider: AgentProviderId | "claude-agent-sdk";
  runtimeOptions?: Record<string, unknown>;
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
