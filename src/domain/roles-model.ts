export type AgentRole = "Orchestrator" | "Developer" | "Polisher" | "Gatekeeper" | "Reviewer";

export interface AgentRoleAssignment {
  id: string;
  role: AgentRole;
}

export interface Roles {
  agents: AgentRoleAssignment[];
}
