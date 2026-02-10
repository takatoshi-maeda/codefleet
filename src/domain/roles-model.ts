export type AgentRole = "PM" | "Developer" | "QA";

export interface AgentRoleAssignment {
  id: string;
  role: AgentRole;
}

export interface Roles {
  agents: AgentRoleAssignment[];
}
