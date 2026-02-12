import type { SystemEvent } from "../../events/router.js";
import type { AgentRole } from "../roles-model.js";

export interface RoleEventPromptDefinition {
  triggerEventType: SystemEvent["type"];
  promptEventType: string;
}

export interface SubscribedEventDefinition {
  triggerEvent: string;
}

export interface AgentRoleDefinition {
  role: AgentRole;
  // Map-like shape keeps "which event wakes this role" and
  // "which task prompt should be used" readable in one place.
  subscribedEvents: Readonly<Partial<Record<SystemEvent["type"], SubscribedEventDefinition>>>;
}

// Keep role behavior in one place so routing, prompts, and queueing policies
// evolve together instead of diverging across separate modules.
const AGENT_ROLE_DEFINITIONS: Record<AgentRole, AgentRoleDefinition> = {
  Orchestrator: {
    role: "Orchestrator",
    subscribedEvents: {},
  },
  Developer: {
    role: "Developer",
    subscribedEvents: {},
  },
  Gatekeeper: {
    role: "Gatekeeper",
    subscribedEvents: {
      "docs.update": {
        triggerEvent: "acceptance-test.update",
      },
    },
  },
};

export function getAgentRoleDefinition(role: AgentRole): AgentRoleDefinition {
  return AGENT_ROLE_DEFINITIONS[role];
}

export function isRoleSubscribedToEvent(role: AgentRole, event: SystemEvent): boolean {
  return AGENT_ROLE_DEFINITIONS[role].subscribedEvents[event.type] !== undefined;
}

export function getRoleEventPromptDefinition(
  role: AgentRole,
  triggerEventType: SystemEvent["type"],
): RoleEventPromptDefinition {
  const roleDefinition = AGENT_ROLE_DEFINITIONS[role];
  const subscribedEvent = roleDefinition.subscribedEvents[triggerEventType];
  if (!subscribedEvent) {
    return {
      triggerEventType,
      promptEventType: triggerEventType,
    };
  }
  return {
    triggerEventType,
    promptEventType: subscribedEvent.triggerEvent,
  };
}
