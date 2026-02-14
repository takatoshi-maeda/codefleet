export type AgentRole = "Orchestrator" | "Developer" | "Gatekeeper" | "Reviewer";

export interface AgentRoleAssignment {
  id: string;
  role: AgentRole;
}

export interface Roles {
  agents: AgentRoleAssignment[];
}
