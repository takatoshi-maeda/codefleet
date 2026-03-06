export type AgentRole = "Orchestrator" | "Curator" | "Developer" | "Polisher" | "Gatekeeper" | "Reviewer";

export interface AgentRoleAssignment {
  id: string;
  role: AgentRole;
}

export interface Roles {
  agents: AgentRoleAssignment[];
}
