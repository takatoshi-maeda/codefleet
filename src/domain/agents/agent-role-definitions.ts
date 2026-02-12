import type { SystemEvent } from "../../events/router.js";
import type { AgentRole } from "../roles-model.js";

export interface AgentRoleDefinition {
  role: AgentRole;
  startupPromptFile: string;
  subscribedEvents: ReadonlySet<SystemEvent["type"]>;
}

// Keep role behavior in one place so routing, prompts, and queueing policies
// evolve together instead of diverging across separate modules.
const AGENT_ROLE_DEFINITIONS: Record<AgentRole, AgentRoleDefinition> = {
  Orchestrator: {
    role: "Orchestrator",
    startupPromptFile: "orchestrator-startup.md",
    subscribedEvents: new Set([]),
  },
  Developer: {
    role: "Developer",
    startupPromptFile: "developer-startup.md",
    subscribedEvents: new Set([]),
  },
  Gatekeeper: {
    role: "Gatekeeper",
    startupPromptFile: "gatekeeper-startup.md",
    subscribedEvents: new Set(["docs.update"]),
  },
};

export function getAgentRoleDefinition(role: AgentRole): AgentRoleDefinition {
  return AGENT_ROLE_DEFINITIONS[role];
}

export function isRoleSubscribedToEvent(role: AgentRole, event: SystemEvent): boolean {
  return AGENT_ROLE_DEFINITIONS[role].subscribedEvents.has(event.type);
}
