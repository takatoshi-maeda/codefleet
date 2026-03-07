import type { AgentRole } from "../roles-model.js";

export type AgentProviderId = "codex-app-server" | "claude-agent-sdk";

export type AgentRuntimeEventKind =
  | "assistant_message"
  | "reasoning"
  | "tool_started"
  | "tool_finished"
  | "conversation_started"
  | "invocation_started"
  | "invocation_finished"
  | "native";

export interface AgentRuntimeEvent {
  agentId: string;
  provider: AgentProviderId;
  occurredAt: string;
  kind: AgentRuntimeEventKind;
  message?: string;
  nativeType?: string;
  conversationId?: string | null;
  activeInvocationId?: string | null;
  payload?: Record<string, unknown>;
}

export type AgentRuntimeEventListener = (event: AgentRuntimeEvent) => void;

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
  currentSession?: RoleAgentRuntimeSessionState;
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
