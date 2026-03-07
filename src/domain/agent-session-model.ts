import type { AgentProviderId } from "./fleet/role-agent-runtime.js";

export type AgentSessionStatus = "disconnected" | "initializing" | "ready" | "error";

export interface AgentSession {
  agentId: string;
  provider: AgentProviderId | "claude-agent-sdk";
  status: AgentSessionStatus;
  initialized: boolean;
  conversationId?: string | null;
  activeInvocationId?: string | null;
  lastActivityAt: string;
  lastError?: string;
}

export interface AgentSessionCollection {
  version: number;
  updatedAt: string;
  sessions: AgentSession[];
}
