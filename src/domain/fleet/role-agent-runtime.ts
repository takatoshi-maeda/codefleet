import type { AgentRole } from "../roles-model.js";

export type AgentProviderId = "codex-app-server";

export interface RoleAgentRuntimeSessionState {
  conversationId: string | null;
  activeInvocationId: string | null;
  lastActivityAt: string;
}

export interface PrepareRoleAgentInput {
  agentId: string;
  role: AgentRole;
  cwd: string;
  detached: boolean;
  startupPrompt: string;
  runtimeConfig: Record<string, unknown>;
  playwrightServerUrl?: string;
}

export interface PrepareRoleAgentResult {
  provider: AgentProviderId;
  pid: number | null;
  startedAt: string;
  session: RoleAgentRuntimeSessionState;
}

export interface ExecuteRoleAgentInput {
  agentId: string;
  role: AgentRole;
  cwd: string;
  prompt: string;
  responseLanguage?: string;
  runtimeConfig: Record<string, unknown>;
}

export interface ExecuteRoleAgentResult {
  provider: AgentProviderId;
  session: RoleAgentRuntimeSessionState;
}

export interface RoleAgentRuntime {
  readonly provider: AgentProviderId;

  prepareAgent(input: PrepareRoleAgentInput): Promise<PrepareRoleAgentResult>;
  execute(input: ExecuteRoleAgentInput): Promise<ExecuteRoleAgentResult>;
  shutdownAgent(agentId: string): Promise<void>;
}
